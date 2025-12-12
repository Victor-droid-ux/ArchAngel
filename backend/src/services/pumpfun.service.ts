import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getConnection, loadKeypairFromEnv } from "./solana.service.js";
import { getLogger } from "../utils/logger.js";
import axios from "axios";

const log = getLogger("pumpfun");

// Pump.fun program constants
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const PUMP_FUN_GLOBAL = new PublicKey(
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
);
const PUMP_FUN_EVENT_AUTHORITY = new PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"
);
const PUMP_FUN_FEE_RECIPIENT = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
);

/**
 * Check if a token is on pump.fun bonding curve (active bonding curve exists)
 */
export async function isPumpFunToken(mintAddress: string): Promise<boolean> {
  try {
    const connection = getConnection();
    const bondingCurve = getPumpFunBondingCurve(mintAddress);

    // Check if bonding curve account actually exists on-chain
    const accountInfo = await connection.getAccountInfo(bondingCurve);

    if (accountInfo) {
      log.info(
        `Token ${mintAddress.slice(0, 8)}... has active pump.fun bonding curve`
      );
      return true;
    }

    log.debug(
      `Token ${mintAddress.slice(0, 8)}... has no active pump.fun bonding curve`
    );
    return false;
  } catch (err) {
    log.warn(
      `Error checking pump.fun status for ${mintAddress.slice(0, 8)}...: ${err}`
    );
    return false;
  }
}

/**
 * Check if a token originated from pump.fun (even if graduated/bonding curve closed)
 * This checks transaction history for pump.fun program interactions
 */
export async function isGraduatedPumpFunToken(
  mintAddress: string
): Promise<boolean> {
  try {
    const connection = getConnection();
    const mint = new PublicKey(mintAddress);

    // Check if token has historical transactions with Pump.fun program
    const signatures = await connection.getSignaturesForAddress(mint, {
      limit: 10, // Check first 10 transactions
    });

    // Look for transactions involving the Pump.fun program
    for (const sig of signatures) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (tx?.transaction?.message?.accountKeys) {
          const accounts = tx.transaction.message.accountKeys;
          const hasPumpFunProgram = accounts.some(
            (acc) => "pubkey" in acc && acc.pubkey.equals(PUMP_FUN_PROGRAM)
          );

          if (hasPumpFunProgram) {
            log.info(
              `Token ${mintAddress.slice(
                0,
                8
              )}... confirmed as Pump.fun origin (found program in tx history)`
            );
            return true;
          }
        }
      } catch (txErr) {
        // Skip failed transaction lookups
        continue;
      }
    }

    log.debug(
      `Token ${mintAddress.slice(
        0,
        8
      )}... no Pump.fun program found in transaction history`
    );
    return false;
  } catch (err) {
    log.warn(
      `Error checking Pump.fun origin for ${mintAddress.slice(0, 8)}...: ${err}`
    );
    return false;
  }
}

/**
 * Get pump.fun bonding curve address for a token
 */
export function getPumpFunBondingCurve(mintAddress: string): PublicKey {
  const mint = new PublicKey(mintAddress);
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  return bondingCurve;
}

/**
 * Get pump.fun associated bonding curve address
 */
export function getPumpFunAssociatedBondingCurve(
  mintAddress: string
): PublicKey {
  const bondingCurve = getPumpFunBondingCurve(mintAddress);
  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [
      bondingCurve.toBuffer(),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
      new PublicKey(mintAddress).toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") // Associated Token Program
  );
  return associatedBondingCurve;
}

/**
 * Get pump.fun price quote
 */
export async function getPumpFunQuote(
  mintAddress: string,
  amountLamports: number,
  isBuy: boolean
): Promise<{ outAmount: number; pricePerToken: number } | null> {
  try {
    const connection = getConnection();
    const bondingCurve = getPumpFunBondingCurve(mintAddress);

    // Fetch bonding curve account data
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    if (!accountInfo) {
      log.warn(
        `No bonding curve found for pump.fun token ${mintAddress.slice(
          0,
          8
        )}...`
      );
      return null;
    }

    // Parse bonding curve state (simplified - actual parsing depends on program layout)
    // This is a placeholder - you'd need to match pump.fun's actual account structure
    const data = accountInfo.data;

    // Rough estimation based on bonding curve formula
    // Pump.fun uses a linear bonding curve: price = k * supply
    const estimatedOutAmount = isBuy
      ? amountLamports * 1000000 // Rough conversion for buy
      : amountLamports / 1000000; // Rough conversion for sell

    const pricePerToken = isBuy
      ? amountLamports / estimatedOutAmount
      : estimatedOutAmount / amountLamports;

    log.info(
      `Pump.fun quote: ${isBuy ? "BUY" : "SELL"} ${
        amountLamports / LAMPORTS_PER_SOL
      } SOL = ${estimatedOutAmount} tokens`
    );

    return {
      outAmount: estimatedOutAmount,
      pricePerToken,
    };
  } catch (err) {
    const msg =
      err && typeof err === "object" && "message" in err
        ? (err as any).message
        : String(err);
    log.error(`Failed to get pump.fun quote: ${msg}`);
    return null;
  }
}

/**
 * Build pump.fun buy instruction
 */
export function buildPumpFunBuyInstruction(
  mintAddress: string,
  userPubkey: PublicKey,
  amountLamports: number,
  maxSolCost: number
): TransactionInstruction {
  const mint = new PublicKey(mintAddress);
  const bondingCurve = getPumpFunBondingCurve(mintAddress);
  const associatedBondingCurve = getPumpFunAssociatedBondingCurve(mintAddress);

  // Get user's associated token account
  const [userTokenAccount] = PublicKey.findProgramAddressSync(
    [
      userPubkey.toBuffer(),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
      mint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );

  // Build instruction data (discriminator + params)
  const instructionData = Buffer.alloc(24);
  instructionData.writeBigUInt64LE(BigInt("0x66063d1201daebea"), 0); // Buy discriminator
  instructionData.writeBigUInt64LE(BigInt(amountLamports), 8);
  instructionData.writeBigUInt64LE(BigInt(maxSolCost), 16);

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM,
    keys: [
      { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      {
        pubkey: new PublicKey("11111111111111111111111111111111"),
        isSigner: false,
        isWritable: false,
      }, // System Program
      {
        pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        isSigner: false,
        isWritable: false,
      }, // Token Program
      {
        pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"),
        isSigner: false,
        isWritable: false,
      }, // Rent
      { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      {
        pubkey: PUMP_FUN_PROGRAM,
        isSigner: false,
        isWritable: false,
      }, // Program
    ],
    data: instructionData,
  });
}

/**
 * Build pump.fun sell instruction
 */
export function buildPumpFunSellInstruction(
  mintAddress: string,
  userPubkey: PublicKey,
  amountTokens: number,
  minSolOutput: number
): TransactionInstruction {
  const mint = new PublicKey(mintAddress);
  const bondingCurve = getPumpFunBondingCurve(mintAddress);
  const associatedBondingCurve = getPumpFunAssociatedBondingCurve(mintAddress);

  // Get user's associated token account
  const [userTokenAccount] = PublicKey.findProgramAddressSync(
    [
      userPubkey.toBuffer(),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
      mint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );

  // Build instruction data (discriminator + params)
  const instructionData = Buffer.alloc(24);
  instructionData.writeBigUInt64LE(BigInt("0x33e685a4017f83ad"), 0); // Sell discriminator
  instructionData.writeBigUInt64LE(BigInt(amountTokens), 8);
  instructionData.writeBigUInt64LE(BigInt(minSolOutput), 16);

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM,
    keys: [
      { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      {
        pubkey: new PublicKey("11111111111111111111111111111111"),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });
}

/**
 * Build unsigned pump.fun transaction for user signing
 */
export async function buildPumpFunTransaction(
  mintAddress: string,
  isBuy: boolean,
  amountLamports: number,
  userPublicKey: string,
  slippageBps: number = 100
): Promise<string | null> {
  try {
    const connection = getConnection();
    const userPubkey = new PublicKey(userPublicKey);

    log.info(
      `Building pump.fun ${
        isBuy ? "BUY" : "SELL"
      } transaction for ${mintAddress.slice(0, 8)}...`
    );

    // Get quote to validate token
    const quote = await getPumpFunQuote(mintAddress, amountLamports, isBuy);
    if (!quote) {
      log.warn("Could not get pump.fun quote");
      return null;
    }

    // Build transaction
    const tx = new Transaction();

    // Add compute budget instructions
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
    );

    // Add trade instruction
    if (isBuy) {
      const maxSolCost = Math.floor(amountLamports * (1 + slippageBps / 10000));
      tx.add(
        buildPumpFunBuyInstruction(
          mintAddress,
          userPubkey,
          amountLamports,
          maxSolCost
        )
      );
    } else {
      const minSolOutput = Math.floor(
        amountLamports * (1 - slippageBps / 10000)
      );
      tx.add(
        buildPumpFunSellInstruction(
          mintAddress,
          userPubkey,
          amountLamports,
          minSolOutput
        )
      );
    }

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPubkey;

    // Serialize transaction (unsigned)
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const base64Tx = Buffer.from(serialized).toString("base64");

    log.info(
      `Built unsigned pump.fun ${
        isBuy ? "BUY" : "SELL"
      } transaction for ${userPublicKey.slice(0, 8)}...`
    );

    return base64Tx;
  } catch (err) {
    const msg =
      err && typeof err === "object" && "message" in err
        ? (err as any).message
        : String(err);
    log.error(`Failed to build pump.fun transaction: ${msg}`);
    return null;
  }
}

/**
 * Execute pump.fun trade (buy or sell)
 * @deprecated Use buildPumpFunTransaction + user signing instead
 */
export async function executePumpFunTrade(
  mintAddress: string,
  isBuy: boolean,
  amountLamports: number,
  userPublicKey?: string,
  slippageBps: number = 100
): Promise<{ signature: string; success: boolean } | null> {
  try {
    const connection = getConnection();
    let wallet: Keypair | null = null;

    // Load backend wallet if needed
    if (!userPublicKey) {
      try {
        wallet = loadKeypairFromEnv();
      } catch (err) {
        log.error("Backend wallet not configured");
        return null;
      }
    }

    const userPubkey = userPublicKey
      ? new PublicKey(userPublicKey)
      : wallet!.publicKey;

    log.info(
      `Preparing pump.fun ${isBuy ? "BUY" : "SELL"} for ${mintAddress.slice(
        0,
        8
      )}...`
    );

    // Get quote
    const quote = await getPumpFunQuote(mintAddress, amountLamports, isBuy);
    if (!quote) {
      log.warn("Could not get pump.fun quote");
      return null;
    }

    // Build transaction
    const tx = new Transaction();

    // Add compute budget instructions
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
    );

    // Add trade instruction
    if (isBuy) {
      const maxSolCost = Math.floor(amountLamports * (1 + slippageBps / 10000));
      tx.add(
        buildPumpFunBuyInstruction(
          mintAddress,
          userPubkey,
          amountLamports,
          maxSolCost
        )
      );
    } else {
      const minSolOutput = Math.floor(
        amountLamports * (1 - slippageBps / 10000)
      );
      tx.add(
        buildPumpFunSellInstruction(
          mintAddress,
          userPubkey,
          amountLamports,
          minSolOutput
        )
      );
    }

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPubkey;

    // Sign and send
    if (!userPublicKey && wallet) {
      // If no user pubkey provided, sign with backend wallet
      tx.sign(wallet);
    }

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    log.info(
      `Pump.fun ${isBuy ? "BUY" : "SELL"} transaction sent: ${signature}`
    );

    // Wait for confirmation
    await connection.confirmTransaction(signature, "confirmed");

    log.info(`Pump.fun trade confirmed: ${signature}`);

    return { signature, success: true };
  } catch (err) {
    const msg =
      err && typeof err === "object" && "message" in err
        ? (err as any).message
        : String(err);
    log.error(`Pump.fun trade failed: ${msg}`);
    return null;
  }
}

export default {
  isPumpFunToken,
  getPumpFunQuote,
  buildPumpFunTransaction,
  executePumpFunTrade,
};
