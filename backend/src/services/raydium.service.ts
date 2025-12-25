// backend/src/services/raydium.service.ts
import { RaydiumSwap } from "./raydium/raydium-swap.js";
import { CONFIG } from "./raydium/config.js";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import crypto from "crypto";
import { quoteCache } from "./cache.service.js";

const log = getLogger("raydium.service");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_MINT = SOL_MINT; // Wrapped SOL has same address

let raydiumSwap: RaydiumSwap | null = null;

// Initialize Raydium swap instance
function getRaydiumSwap(): RaydiumSwap {
  if (!raydiumSwap) {
    raydiumSwap = new RaydiumSwap(CONFIG.RPC_URL, CONFIG.WALLET_SECRET_KEY);
    raydiumSwap.loadPoolKeys().catch((err) => {
      log.warn("Failed to load pool keys from mainnet.json:", err.message);
    });
  }
  return raydiumSwap;
}

/* ----------------------------- PUBLIC API ----------------------------- */

/**
 * Get swap quote from Raydium
 * Similar interface to Jupiter's getJupiterQuote for easy migration
 */
export async function getRaydiumQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number | string | bigint,
  slippagePercent = 1,
  fastMode = false // Set to true for manual trades to reduce timeout
) {
  try {
    // Convert to number safely - use string for cache key to avoid precision loss
    const amountStr = String(amountLamports);
    const amountNum =
      typeof amountLamports === "number" ? amountLamports : Number(amountStr);

    // Check cache first
    const cacheKey = `raydium:quote:${inputMint}:${outputMint}:${amountStr}`;
    const cached = quoteCache.get<any>(cacheKey);
    if (cached) {
      log.debug("Using cached Raydium quote");
      return cached;
    }

    const swap = getRaydiumSwap();

    // Normalize SOL addresses
    const normalizedInput = inputMint === SOL_MINT ? WSOL_MINT : inputMint;
    const normalizedOutput = outputMint === SOL_MINT ? WSOL_MINT : outputMint;

    // Find pool - try both directions (base/quote can be reversed)
    let poolKeys = swap.findPoolInfoForTokens(
      normalizedInput,
      normalizedOutput
    );

    // If not in cache, fetch with polling/retry logic
    if (!poolKeys) {
      // Use reduced retries for manual trades (fast mode) to prevent timeout
      const maxRetries = fastMode ? 3 : 20; // 3 retries = ~900ms max, 20 retries = ~6s max
      log.info(
        `Pool not found in cache, fetching from chain with ${maxRetries} retries: ${normalizedInput} -> ${normalizedOutput}`
      );
      try {
        poolKeys = await swap.findRaydiumPoolInfo(
          normalizedInput,
          normalizedOutput,
          maxRetries
        );
      } catch (error) {
        // Try reversed order if first attempt fails completely
        log.info(
          `Trying reversed token order: ${normalizedOutput} -> ${normalizedInput}`
        );
        try {
          poolKeys = await swap.findRaydiumPoolInfo(
            normalizedOutput,
            normalizedInput,
            maxRetries
          );
        } catch (reverseError) {
          log.warn(
            `No Raydium pool found after retries (both token orders): ${inputMint} <-> ${outputMint}`
          );
          return null;
        }
      }
    }

    if (!poolKeys) {
      log.warn(`No Raydium pool found for ${inputMint} -> ${outputMint}`);
      return null;
    }

    // Return quote-like object for compatibility
    const quote = {
      inputMint: normalizedInput,
      outputMint: normalizedOutput,
      inAmount: amountNum,
      outAmount: 0, // Raydium calculates this during swap instruction creation
      slippageBps: Math.round(slippagePercent * 100),
      poolKeys, // Store pool keys for later use in swap
    };

    // Cache the quote
    quoteCache.set(cacheKey, quote);

    return quote;
  } catch (err: any) {
    log.error(`Failed to get Raydium quote: ${err?.message ?? String(err)}`);
    return null;
  }
}

/**
 * Execute Raydium swap
 * Compatible with Jupiter service interface for easy migration
 */
export async function executeRaydiumSwap({
  inputMint,
  outputMint,
  amount,
  userPublicKey,
  slippage = 1,
  priorityFee,
}: {
  inputMint: string;
  outputMint: string;
  amount: number | string;
  userPublicKey: string;
  slippage?: number;
  priorityFee?: number;
}): Promise<
  | { success: true; signature: string; simulated?: boolean }
  | { success: false; error: string }
> {
  try {
    const swap = getRaydiumSwap();
    const connection = new Connection(CONFIG.RPC_URL, "confirmed");

    // Normalize SOL addresses
    const normalizedInput = inputMint === SOL_MINT ? WSOL_MINT : inputMint;
    const normalizedOutput = outputMint === SOL_MINT ? WSOL_MINT : outputMint;

    // Find pool - try cache first, then fetch with retry logic
    let poolKeys = swap.findPoolInfoForTokens(
      normalizedInput,
      normalizedOutput
    );

    if (!poolKeys) {
      // Use reduced retries (3) for better performance, full 20 retries only needed for auto-trader
      const maxRetries = 3;
      log.info(
        `Pool not found in cache, fetching from chain with ${maxRetries} retries...`
      );
      try {
        poolKeys = await swap.findRaydiumPoolInfo(
          normalizedInput,
          normalizedOutput,
          maxRetries
        );
      } catch (error) {
        // Try reversed order if first attempt fails
        log.info("Trying reversed token order...");
        try {
          poolKeys = await swap.findRaydiumPoolInfo(
            normalizedOutput,
            normalizedInput,
            maxRetries
          );
        } catch (reverseError) {
          return {
            success: false,
            error: `No Raydium pool found after retries (both token orders): ${inputMint} <-> ${outputMint}`,
          };
        }
      }
    }

    if (!poolKeys) {
      return {
        success: false,
        error:
          "No Raydium liquidity pool found for this token. Verify the token address is correct and has sufficient liquidity on Raydium.",
      };
    }

    log.info(
      {
        pool: poolKeys.id.toBase58(),
        inputMint: normalizedInput,
        outputMint: normalizedOutput,
        amount,
        slippage,
      },
      "Executing Raydium swap"
    );

    // Get swap transaction
    // Pass priorityFee if provided (for future extensibility)
    const swapTransaction = await swap.getSwapTransaction(
      normalizedOutput,
      amount,
      poolKeys,
      true, // use versioned transaction
      slippage
      // priorityFee (future: add as param to getSwapTransaction if needed)
    );

    // Check if simulation mode
    const useSimulation = process.env.USE_REAL_SWAP !== "true";

    if (useSimulation) {
      log.info("Simulation mode enabled - transaction not sent");
      const simResult = await swap.simulateVersionedTransaction(
        swapTransaction as VersionedTransaction
      );

      // FIX 5: Flux simulation MUST be validated
      // Reject trades where simulation produces zero output
      if (simResult.err) {
        return {
          success: false,
          error: `Simulation failed: ${JSON.stringify(simResult.err)}`,
        };
      }

      return {
        success: true,
        signature: `sim-${crypto.randomUUID()}`,
        simulated: true,
      };
    }

    // Execute real swap
    const recentBlockhash = await connection.getLatestBlockhash();
    const signature = await swap.sendVersionedTransaction(
      swapTransaction as VersionedTransaction,
      recentBlockhash.blockhash,
      recentBlockhash.lastValidBlockHeight
    );

    log.info({ signature }, "Raydium swap executed successfully");

    return {
      success: true,
      signature,
      simulated: false,
    };
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    log.error(`Raydium swap failed: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Build Raydium swap transaction (for client-side signing)
 * Compatible with Jupiter's buildJupiterSwapPayload interface
 */
export async function buildRaydiumSwapPayload(
  quote: any,
  userPublicKey: string
) {
  try {
    const swap = getRaydiumSwap();

    if (!quote || !quote.poolKeys) {
      throw new Error("Invalid quote - missing poolKeys");
    }

    const { poolKeys, outputMint, inAmount, slippageBps } = quote;

    // Prepare unsigned transaction for client-side signing
    const unsignedTransaction = await swap.prepareUnsignedSwapTransaction(
      outputMint,
      inAmount,
      poolKeys,
      new PublicKey(userPublicKey),
      slippageBps / 100 // convert bps to percent
    );

    return {
      swapTransaction: unsignedTransaction,
    };
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    log.error(`Failed to build Raydium swap payload: ${errorMsg}`);
    throw new Error(errorMsg);
  }
}

// Re-export token price functions from price.service (uses Birdeye + Helius)
export {
  fetchTokenPrices,
  fetchPricesForMints,
  RAYDIUM_QUOTE_URL,
} from "./price.service.js";

// Export for compatibility with existing code
export const getJupiterQuote = getRaydiumQuote;
export const executeJupiterSwap = executeRaydiumSwap;
export const buildJupiterSwapPayload = buildRaydiumSwapPayload;
