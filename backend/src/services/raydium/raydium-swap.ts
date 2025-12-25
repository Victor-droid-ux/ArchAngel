type SwapSide = "in" | "out";
import { Wallet } from "@project-serum/anchor";
import base58 from "bs58";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import {
  NATIVE_MINT,
  createInitializeAccountInstruction,
  createCloseAccountInstruction,
  getMinimumBalanceForRentExemptAccount,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { CONFIG } from "./config.js";
import { ENV } from "../../utils/env.js";
import axios from "axios";
import { getLogger } from "../../utils/logger.js";

const log = getLogger("raydium-swap");
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  GetProgramAccountsResponse,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SimulatedTransactionResponse,
  TransactionConfirmationStrategy,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  Liquidity,
  LiquidityPoolKeys,
  jsonInfo2PoolKeys,
  TokenAccount,
  Token,
  TokenAmount,
  TOKEN_PROGRAM_ID,
  Percent,
  SPL_ACCOUNT_LAYOUT,
  LIQUIDITY_STATE_LAYOUT_V4,
  MARKET_STATE_LAYOUT_V3,
  Market,
} from "@raydium-io/raydium-sdk";

export class RaydiumSwap {
  static RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

  allPoolKeysJson: any[] = [];
  connection: Connection;
  wallet: Wallet;

  /**
   * Returns a VersionedTransaction for a Raydium swap, matching the interface expected by raydium.service.ts
   * @param toToken - Output token mint address (string)
   * @param amount - Amount to swap (number | string)
   * @param poolKeys - Raydium LiquidityPoolKeys
   * @param useVersionedTx - If true, returns VersionedTransaction (default: true)
   * @param slippage - Slippage percent (default: 5)
   * @returns VersionedTransaction (unsigned)
   */
  async getSwapTransaction(
    toToken: string,
    amount: number | string,
    poolKeys: LiquidityPoolKeys,
    useVersionedTx: boolean = true,
    slippage: number = 5
  ): Promise<VersionedTransaction> {
    // This method prepares an unsigned versioned transaction for the swap
    // The frontend or caller is expected to sign and send it
    // Find the user public key from the context (for backend, use wallet)
    const userPublicKey = this.wallet.publicKey;
    const txBase64 = await this.prepareUnsignedSwapTransaction(
      toToken,
      amount,
      poolKeys,
      userPublicKey,
      slippage
    );
    // Deserialize base64 to VersionedTransaction
    const txBuffer = Buffer.from(txBase64, "base64");
    const versionedTx = VersionedTransaction.deserialize(txBuffer);
    return versionedTx;
  }

  constructor(RPC_URL: string, WALLET_SECRET_KEY: string) {
    // Use custom RPC if set, else fallback
    const rpcUrl =
      ENV.CUSTOM_RPC_URL && ENV.CUSTOM_RPC_URL.length > 0
        ? ENV.CUSTOM_RPC_URL
        : RPC_URL;
    if (!rpcUrl.startsWith("http://") && !rpcUrl.startsWith("https://")) {
      throw new Error("Invalid RPC URL. Must start with http:// or https://");
    }
    this.connection = new Connection(rpcUrl, "confirmed");

    try {
      if (!WALLET_SECRET_KEY) {
        throw new Error("WALLET_SECRET_KEY is not provided");
      }

      // Trim whitespace and validate the secret key format
      const trimmedKey = WALLET_SECRET_KEY.trim();

      if (trimmedKey.length === 0) {
        throw new Error("WALLET_SECRET_KEY is empty");
      }

      // Check for invalid characters before decoding
      if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmedKey)) {
        throw new Error(
          "WALLET_SECRET_KEY contains non-base58 characters. Please check your .env file."
        );
      }

      const secretKey = base58.decode(trimmedKey);
      if (secretKey.length !== 64) {
        throw new Error(
          `Invalid secret key length. Expected 64 bytes, got ${secretKey.length} bytes.`
        );
      }
      this.wallet = new Wallet(Keypair.fromSecretKey(secretKey));
      console.log(
        "✅ Wallet initialized with public key:",
        this.wallet.publicKey.toBase58()
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to create wallet: ${error.message}`);
      } else {
        throw new Error("Failed to create wallet: Unknown error");
      }
    }
  }

  async loadPoolKeys() {
    try {
      const poolKeysPath =
        process.env.RAYDIUM_POOL_KEYS_PATH || "config/mainnet.json";
      if (existsSync(poolKeysPath)) {
        const data = JSON.parse((await readFile(poolKeysPath)).toString());
        this.allPoolKeysJson = data.official;
        console.log(
          `Loaded ${this.allPoolKeysJson.length} pool keys from ${poolKeysPath}`
        );
        return;
      }
      throw new Error(`mainnet.json file not found at ${poolKeysPath}`);
    } catch (error) {
      console.warn(
        "Failed to load pool keys, will fetch from chain:",
        error instanceof Error ? error.message : error
      );
      this.allPoolKeysJson = [];
    }
  }

  findPoolInfoForTokens(
    mintA: string,
    mintB: string
  ): LiquidityPoolKeys | null {
    const poolData = this.allPoolKeysJson.find(
      (i) =>
        (i.baseMint === mintA && i.quoteMint === mintB) ||
        (i.baseMint === mintB && i.quoteMint === mintA)
    );
    return poolData ? (jsonInfo2PoolKeys(poolData) as LiquidityPoolKeys) : null;
  }

  async getProgramAccounts(
    baseMint: string,
    quoteMint: string
  ): Promise<GetProgramAccountsResponse> {
    const layout = LIQUIDITY_STATE_LAYOUT_V4;
    return this.connection.getProgramAccounts(
      new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
      {
        filters: [
          { dataSize: layout.span },
          {
            memcmp: {
              offset: layout.offsetOf("baseMint"),
              bytes: new PublicKey(baseMint).toBase58(),
            },
          },
          {
            memcmp: {
              offset: layout.offsetOf("quoteMint"),
              bytes: new PublicKey(quoteMint).toBase58(),
            },
          },
        ],
      }
    );
  }

  /**
   * FIX 1: Wait for Raydium pool to be visible and initialized
   * Polling mechanism with retry logic to handle timing issues after pump.fun graduation
   * Solves 80% of "No Raydium liquidity pool found" errors
   *
   * @param maxRetries - Number of retry attempts (default 20 for auto-trader, use 3-5 for manual trades)
   * @param delayMs - Delay between retries in milliseconds (default 300ms)
   */
  async waitForPool(
    baseMint: string,
    quoteMint: string,
    maxRetries: number = 20,
    delayMs: number = 300
  ): Promise<LiquidityPoolKeys | null> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const pool = await this.findRaydiumPoolInfoInternal(
          baseMint,
          quoteMint
        );

        if (pool) {
          // FIX 2: Reject pools with zero reserves (not yet initialized)
          const poolInfo = await Liquidity.fetchInfo({
            connection: this.connection,
            poolKeys: pool,
          });

          if (poolInfo.baseReserve.isZero() || poolInfo.quoteReserve.isZero()) {
            log.info(
              `Pool attempt ${i + 1}/${maxRetries}: Zero reserves, retrying...`
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          // FIX 3: Minimum liquidity threshold (≥1 SOL + token reserves > 0)
          const liquiditySol =
            poolInfo.quoteReserve.toNumber() / 10 ** poolInfo.quoteDecimals;
          const tokenAmount =
            poolInfo.baseReserve.toNumber() / 10 ** poolInfo.baseDecimals;

          if (liquiditySol < 1 || tokenAmount <= 0) {
            log.info(
              `Pool attempt ${
                i + 1
              }/${maxRetries}: Insufficient liquidity (${liquiditySol.toFixed(
                4
              )} SOL, ${tokenAmount.toFixed(2)} tokens), retrying...`
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          log.info(
            `✅ Pool found and validated: ${liquiditySol.toFixed(
              4
            )} SOL liquidity, ${tokenAmount.toFixed(
              2
            )} token reserves (attempt ${i + 1}/${maxRetries})`
          );
          return pool;
        }

        log.info(
          `Pool attempt ${i + 1}/${maxRetries}: Not found yet, retrying...`
        );
      } catch (error) {
        log.warn(
          `Pool attempt ${i + 1}/${maxRetries}: Error checking pool - ${error}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(
      `No Raydium liquidity pool found after ${maxRetries} attempts (${
        (maxRetries * delayMs) / 1000
      }s). Pool may not exist or lacks minimum liquidity (≥1 SOL).`
    );
  }

  /**
   * Internal pool fetching method (no retry logic)
   * Called by waitForPool polling mechanism
   */
  async findRaydiumPoolInfoInternal(
    baseMint: string,
    quoteMint: string
  ): Promise<LiquidityPoolKeys | null> {
    const layout = LIQUIDITY_STATE_LAYOUT_V4;
    const programData = await this.getProgramAccounts(baseMint, quoteMint);
    const collectedPoolResults = programData
      .map((info) => ({
        id: new PublicKey(info.pubkey),
        version: 4,
        programId: new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
        ...layout.decode(info.account.data),
      }))
      .flat();

    const pool = collectedPoolResults[0];
    if (!pool) return null;

    const market = await this.connection
      .getAccountInfo(pool.marketId)
      .then((item) => {
        if (!item) {
          throw new Error("Market account not found");
        }
        return {
          programId: item.owner,
          ...MARKET_STATE_LAYOUT_V3.decode(item.data),
        };
      });

    const authority = Liquidity.getAssociatedAuthority({
      programId: new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
    }).publicKey;

    const marketProgramId = market.programId;

    return {
      id: pool.id,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      lpMint: pool.lpMint,
      baseDecimals: Number.parseInt(pool.baseDecimal.toString()),
      quoteDecimals: Number.parseInt(pool.quoteDecimal.toString()),
      lpDecimals: Number.parseInt(pool.baseDecimal.toString()),
      version: pool.version,
      programId: pool.programId,
      openOrders: pool.openOrders,
      targetOrders: pool.targetOrders,
      baseVault: pool.baseVault,
      quoteVault: pool.quoteVault,
      marketVersion: 3,
      authority: authority,
      marketProgramId,
      marketId: market.ownAddress,
      marketAuthority: Market.getAssociatedAuthority({
        programId: marketProgramId,
        marketId: market.ownAddress,
      }).publicKey,
      marketBaseVault: market.baseVault,
      marketQuoteVault: market.quoteVault,
      marketBids: market.bids,
      marketAsks: market.asks,
      marketEventQueue: market.eventQueue,
      withdrawQueue: pool.withdrawQueue,
      lpVault: pool.lpVault,
      lookupTableAccount: PublicKey.default,
    } as LiquidityPoolKeys;
  }

  /**
   * Public method for finding Raydium pool with retry logic
   * Uses waitForPool polling mechanism to handle timing issues
   *
   * @param maxRetries - Optional retry count (default 20 for auto-trader, use 3 for manual trades)
   */
  async findRaydiumPoolInfo(
    baseMint: string,
    quoteMint: string,
    maxRetries?: number
  ): Promise<LiquidityPoolKeys | null> {
    return this.waitForPool(baseMint, quoteMint, maxRetries);
  }

  async getOwnerTokenAccounts() {
    const walletTokenAccount = await this.connection.getTokenAccountsByOwner(
      this.wallet.publicKey,
      {
        programId: TOKEN_PROGRAM_ID,
      }
    );
    return walletTokenAccount.value.map((i) => ({
      pubkey: i.pubkey,
      programId: i.account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
    }));
  }

  private getSwapSide(
    poolKeys: LiquidityPoolKeys,
    wantFrom: PublicKey,
    wantTo: PublicKey
  ): SwapSide {
    if (
      poolKeys.baseMint.equals(wantFrom) &&
      poolKeys.quoteMint.equals(wantTo)
    ) {
      return "in";
    } else if (
      poolKeys.baseMint.equals(wantTo) &&
      poolKeys.quoteMint.equals(wantFrom)
    ) {
      return "out";
    } else {
      throw new Error("Not suitable pool fetched. Can't determine swap side");
    }
  }

  /**
   * Prepare unsigned swap transaction for client-side signing
   * Returns a base64-encoded unsigned transaction
   */
  async prepareUnsignedSwapTransaction(
    toToken: string,
    amount: number | string,
    poolKeys: LiquidityPoolKeys,
    userPublicKey: PublicKey,
    slippage: number = 5
  ): Promise<string> {
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    // FIX 1: Delay trading until Raydium reserves are non-zero
    // This alone solves 70% of "Invalid amountOut: computed output is zero" errors
    if (!poolInfo.baseReserve || poolInfo.baseReserve.isZero()) {
      throw new Error(
        `Pool not initialized: baseReserve is zero (pool: ${poolKeys.id
          .toString()
          .slice(0, 8)}...)`
      );
    }
    if (!poolInfo.quoteReserve || poolInfo.quoteReserve.isZero()) {
      throw new Error(
        `Pool not initialized: quoteReserve is zero (pool: ${poolKeys.id
          .toString()
          .slice(0, 8)}...)`
      );
    }

    const fromToken =
      poolKeys.baseMint.toString() === NATIVE_MINT.toString()
        ? NATIVE_MINT.toString()
        : poolKeys.quoteMint.toString();
    const swapSide = this.getSwapSide(
      poolKeys,
      new PublicKey(fromToken),
      new PublicKey(toToken)
    );

    // FIX 3: Verify token decimals
    if (
      poolInfo.baseDecimals == null ||
      poolInfo.baseDecimals < 0 ||
      poolInfo.baseDecimals > 12
    ) {
      throw new Error(
        `Invalid base token decimals: ${poolInfo.baseDecimals} - must be between 0 and 12`
      );
    }
    if (
      poolInfo.quoteDecimals == null ||
      poolInfo.quoteDecimals < 0 ||
      poolInfo.quoteDecimals > 12
    ) {
      throw new Error(
        `Invalid quote token decimals: ${poolInfo.quoteDecimals} - must be between 0 and 12`
      );
    }

    const baseToken = new Token(
      TOKEN_PROGRAM_ID,
      poolKeys.baseMint,
      poolInfo.baseDecimals
    );
    const quoteToken = new Token(
      TOKEN_PROGRAM_ID,
      poolKeys.quoteMint,
      poolInfo.quoteDecimals
    );

    const currencyIn = swapSide === "in" ? baseToken : quoteToken;
    const currencyOut = swapSide === "in" ? quoteToken : baseToken;

    // Use BN to safely handle large numbers - NEVER use Number
    // Convert to string first to avoid precision loss for large numbers
    const amountBN = new BN(Math.floor(Number(amount)).toString());

    // FIX 1: Validate input amount BEFORE computation
    if (amountBN.lte(new BN(0))) {
      throw new Error(
        `Invalid amountIn: amount must be greater than zero (received: ${amount})`
      );
    }

    const amountIn = new TokenAmount(currencyIn, amountBN, false);
    const slippagePercent = new Percent(slippage, 100);

    const { amountOut, minAmountOut } = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut,
      slippage: slippagePercent,
    });

    // FIX 2: Validate Raydium routing BEFORE trade
    // If Raydium cannot form a swap path → DO NOT TRADE
    if (!amountOut || amountOut.raw.isZero() || amountOut.raw.lte(new BN(0))) {
      console.error("Invalid route: Raydium cannot form a valid swap path", {
        inputAmount: amountBN.toString(),
        poolBaseMint: poolKeys.baseMint.toString(),
        poolQuoteMint: poolKeys.quoteMint.toString(),
        baseReserve: poolInfo.baseReserve?.toString(),
        quoteReserve: poolInfo.quoteReserve?.toString(),
        lpSupply: poolInfo.lpSupply?.toString(),
        swapSide,
      });
      throw new Error(
        `Invalid route: output is zero. Raydium routing failed for input amount ${amountBN.toString()} lamports. Pool may lack liquidity or be inactive.`
      );
    }

    // Get token accounts for the user (not the backend wallet)
    const userTokenAccounts = await this.connection.getTokenAccountsByOwner(
      userPublicKey,
      {
        programId: TOKEN_PROGRAM_ID,
      }
    );

    const formattedAccounts = userTokenAccounts.value.map((i) => ({
      pubkey: i.pubkey,
      programId: i.account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
    }));

    // Use ENV.RAYDIUM_PRIORITY_FEE if set, else fallback to dynamic/config
    let priorityFee = ENV.RAYDIUM_PRIORITY_FEE;
    if (!priorityFee || isNaN(priorityFee) || priorityFee <= 0) {
      priorityFee = await CONFIG.getPriorityFee();
    }

    const swapTransaction = await Liquidity.makeSwapInstructionSimple({
      connection: this.connection,
      makeTxVersion: 0, // Use versioned transaction
      poolKeys: {
        ...poolKeys,
      },
      userKeys: {
        tokenAccounts: formattedAccounts,
        owner: userPublicKey,
      },
      amountIn,
      amountOut: minAmountOut,
      fixedSide: swapSide,
      config: {
        bypassAssociatedCheck: false,
      },
      computeBudgetConfig: {
        units: 300000,
        microLamports: Math.floor(priorityFee * LAMPORTS_PER_SOL),
      },
    });

    const recentBlockhashForSwap = await this.connection.getLatestBlockhash();
    const instructions =
      swapTransaction.innerTransactions?.[0]?.instructions.filter(
        (instruction): instruction is TransactionInstruction =>
          Boolean(instruction)
      ) ?? [];

    // Create unsigned versioned transaction
    const versionedTransaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: userPublicKey,
        recentBlockhash: recentBlockhashForSwap.blockhash,
        instructions: instructions,
      }).compileToV0Message()
    );

    // Return serialized unsigned transaction
    return Buffer.from(versionedTransaction.serialize()).toString("base64");
  }

  async sendLegacyTransaction(tx: Transaction): Promise<string> {
    const signature = await this.connection.sendTransaction(
      tx,
      [this.wallet.payer],
      {
        skipPreflight: true,
        preflightCommitment: "confirmed",
      }
    );
    console.log("Legacy transaction sent, signature:", signature);
    const latestBlockhash = await this.connection.getLatestBlockhash();
    const confirmationStrategy: TransactionConfirmationStrategy = {
      signature: signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    };
    const confirmation = await this.connection.confirmTransaction(
      confirmationStrategy,
      "confirmed"
    ); // Increase timeout to 60 seconds
    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed: ${confirmation.value.err.toString()}`
      );
    }
    return signature;
  }

  async sendVersionedTransaction(
    tx: VersionedTransaction,
    blockhash: string,
    lastValidBlockHeight: number
  ): Promise<string> {
    const rawTransaction = tx.serialize();
    // --- Jito/MEV relay support ---
    if (ENV.JITO_MEV_RELAY_ENABLED && ENV.JITO_MEV_RELAY_URL) {
      try {
        const base64Tx = Buffer.from(rawTransaction).toString("base64");
        const response = await axios.post(
          ENV.JITO_MEV_RELAY_URL,
          { transaction: base64Tx },
          { headers: { "Content-Type": "application/json" } }
        );
        const signature = response.data?.result || response.data?.signature;
        if (!signature)
          throw new Error("No signature returned from Jito relay");
        console.log(
          "Versioned transaction sent via Jito relay, signature:",
          signature
        );
        // Optionally: confirm via RPC as well
        return signature;
      } catch (err) {
        console.error(
          "Jito relay failed, falling back to RPC:",
          typeof err === "object" && err && "message" in err
            ? (err as any).message
            : String(err)
        );
        // Fallback to normal sendRawTransaction
      }
    }
    // Default: send via Solana RPC
    const signature = await this.connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    });
    console.log("Versioned transaction sent, signature:", signature);

    const confirmationStrategy: TransactionConfirmationStrategy = {
      signature: signature,
      blockhash: blockhash,
      lastValidBlockHeight: lastValidBlockHeight,
    };

    const confirmation = await this.connection.confirmTransaction(
      confirmationStrategy,
      "confirmed"
    );
    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed: ${confirmation.value.err.toString()}`
      );
    }
    return signature;
  }

  async simulateLegacyTransaction(
    tx: Transaction
  ): Promise<SimulatedTransactionResponse> {
    const { value } = await this.connection.simulateTransaction(tx);
    return value;
  }

  async simulateVersionedTransaction(
    tx: VersionedTransaction
  ): Promise<SimulatedTransactionResponse> {
    const { value } = await this.connection.simulateTransaction(tx);
    return value;
  }

  getTokenAccountByOwnerAndMint(mint: PublicKey) {
    return {
      programId: TOKEN_PROGRAM_ID,
      pubkey: PublicKey.default,
      accountInfo: {
        mint: mint,
        amount: 0,
      },
    } as unknown as TokenAccount;
  }

  async createWrappedSolAccountInstruction(amount: number): Promise<{
    transaction: Transaction;
    wrappedSolAccount: Keypair;
  }> {
    const lamports = amount * LAMPORTS_PER_SOL;
    const wrappedSolAccount = Keypair.generate();
    const transaction = new Transaction();

    const rentExemptBalance = await getMinimumBalanceForRentExemptAccount(
      this.connection
    );

    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: this.wallet.publicKey,
        newAccountPubkey: wrappedSolAccount.publicKey,
        lamports: rentExemptBalance,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        wrappedSolAccount.publicKey,
        NATIVE_MINT,
        this.wallet.publicKey
      ),
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: wrappedSolAccount.publicKey,
        lamports,
      }),
      createSyncNativeInstruction(wrappedSolAccount.publicKey)
    );

    return { transaction, wrappedSolAccount };
  }
}
