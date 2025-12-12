import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";

import {
  Liquidity,
  LiquidityPoolKeys,
  LiquidityPoolInfo,
  Percent,
  TokenAmount,
  Token,
  TOKEN_PROGRAM_ID,
} from "@raydium-io/raydium-sdk";

import bs58 from "bs58";
import { getLogger } from "../../utils/logger.js";
import { ENV } from "../../utils/env.js";
import { getPoolForToken } from "./raydium.pools.js"; //
import { buildPriorityFeeIxs } from "./raydium.priority.js";

const log = getLogger("raydium-sell-service");

const RPC =
  ENV.SOLANA_RPC_URL ||
  ENV.HELIUS_RPC_URL ||
  "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});

// Admin keypair (only if server handles sell)
const ADMIN_PK = ENV.ADMIN_WALLET_SECRET
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(ENV.ADMIN_WALLET_SECRET)))
  : null;

if (!ADMIN_PK) {
  log.warn("⚠️ No ADMIN_PRIVATE_KEY loaded. Server-side sell disabled.");
}

/* ----------------------------------------------------
   SELL via Raydium AMM
---------------------------------------------------- */

export async function sellTokenRaydium(params: {
  mint: string;
  amountSol: number;
  slippageBps?: number;
  wallet?: Keypair; // optional user wallet
  priorityFee?: number;
}) {
  try {
    const {
      mint,
      amountSol,
      wallet = ADMIN_PK,
      slippageBps = 1000,
      priorityFee = 30000,
    } = params;

    if (!wallet) throw new Error("❌ No wallet provided for selling.");

    const owner = wallet.publicKey;
    const tokenMint = new PublicKey(mint);

    /* ----------------------------------------------------
       1. Fetch pool data for this token
    ---------------------------------------------------- */
    const pool = await getPoolForToken(tokenMint);
    if (!pool) throw new Error("❌ No Raydium pool found for token: " + mint);

    const poolKeys: LiquidityPoolKeys = pool.poolKeys;
    const poolInfo: LiquidityPoolInfo = pool.poolInfo;

    log.info(`📤 Selling token ${mint} via Raydium AMM`);

    /* ----------------------------------------------------
       2. Amount (token equivalent)
    ---------------------------------------------------- */
    const tokenDecimals = poolKeys.baseDecimals;
    const token = new Token(TOKEN_PROGRAM_ID, tokenMint, tokenDecimals);
    // Use BN to safely handle large token amounts - NEVER use Number
    const tokenAmountRaw = Math.floor(amountSol * 10 ** tokenDecimals);
    const tokenAmount = new TokenAmount(token, new BN(tokenAmountRaw), false);

    /* ----------------------------------------------------
       3. Build Sell (Swap) Tx
    ---------------------------------------------------- */
    const slippage = new Percent(slippageBps, 10000);

    const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
      connection,
      poolKeys,
      userKeys: {
        tokenAccounts: [],
        owner,
      },
      amountIn: tokenAmount,
      amountOut: new TokenAmount(
        new Token(TOKEN_PROGRAM_ID, poolKeys.quoteMint, poolKeys.quoteDecimals),
        new BN(1)
      ),
      fixedSide: "in",
      makeTxVersion: 0,
    });

    if (
      !innerTransactions ||
      innerTransactions.length === 0 ||
      !innerTransactions[0]
    ) {
      throw new Error("❌ Failed to build Raydium sell transaction");
    }

    const ixs = [...innerTransactions[0].instructions];

    /* ----------------------------------------------------
       4. Priority fees (optional)
    ---------------------------------------------------- */
    const priorityIxs = buildPriorityFeeIxs(priorityFee);
    priorityIxs.forEach((ix) => ixs.unshift(ix));

    /* ----------------------------------------------------
       5. Build TX
    ---------------------------------------------------- */
    const tx = new Transaction().add(...ixs);

    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    tx.sign(wallet);

    /* ----------------------------------------------------
       6. Send transaction
    ---------------------------------------------------- */
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    log.info(`💰 Sell submitted: ${sig}`);

    const confirmation = await connection.confirmTransaction(sig, "confirmed");

    if (confirmation.value.err) {
      throw new Error(
        "❌ Sell transaction failed: " + JSON.stringify(confirmation.value.err)
      );
    }

    log.info(`✅ Sell confirmed: ${sig}`);

    return {
      success: true,
      signature: sig,
    };
  } catch (err: any) {
    log.error("❌ Raydium Sell Error: " + err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}
