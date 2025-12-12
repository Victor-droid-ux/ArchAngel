// backend/src/services/trancheBuyer.service.ts
import { getRaydiumQuote, executeRaydiumSwap } from "./raydium.service.js";
import { executePumpFunTrade } from "./pumpfun.service.js";
import { getLogger } from "../utils/logger.js";
import crypto from "crypto";

const LOG = getLogger("tranche-buyer");

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface TrancheResult {
  success: boolean;
  tokenQty?: number; // Token quantity received
  pricePerToken?: number; // SOL per token
  signature?: string | undefined;
  error?: string;
}

/**
 * Execute first tranche buy (60% of position)
 * Returns token quantity and price for tracking
 */
export async function executeFirstTranche(
  mint: string,
  totalBuySol: number,
  wallet: string,
  isPumpFun: boolean,
  useReal: boolean
): Promise<TrancheResult> {
  try {
    const firstTrancheSol = totalBuySol * 0.6; // 60% of position
    const lamports = Math.floor(firstTrancheSol * 1e9);

    LOG.info(
      {
        mint,
        totalSol: totalBuySol,
        trancheSol: firstTrancheSol,
        isPumpFun,
        useReal,
      },
      "Executing first tranche (60%)"
    );

    // Get quote to estimate token amount with slippage 8-12%
    const slippage = Number(process.env.MAX_SLIPPAGE_PCT || 10); // Default 10%
    const quote = await getRaydiumQuote(SOL_MINT, mint, lamports, slippage);
    if (!quote?.outAmount) {
      return { success: false, error: "No quote for first tranche" };
    }

    // Check if price impact is extreme (>15% = abort)
    if (quote.priceImpactPct && quote.priceImpactPct > 15) {
      return {
        success: false,
        error: `Price impact too high: ${quote.priceImpactPct.toFixed(2)}%`,
      };
    }

    // Execute swap
    let swap: {
      success: boolean;
      signature?: string;
      error?: string;
    };

    if (useReal) {
      if (isPumpFun) {
        const slippageBps = slippage * 100; // Convert to basis points
        const pumpResult = await executePumpFunTrade(
          mint,
          true,
          lamports,
          wallet,
          slippageBps // Use configured slippage
        );
        swap = pumpResult
          ? { success: pumpResult.success, signature: pumpResult.signature }
          : { success: false, error: "Pump.fun first tranche failed" };
      } else {
        swap = await executeRaydiumSwap({
          inputMint: SOL_MINT,
          outputMint: mint,
          amount: lamports,
          userPublicKey: wallet,
          slippage: slippage,
        });
      }
    } else {
      swap = {
        success: true,
        signature: `sim-tranche1-${Date.now()}`,
      };
    }

    if (!swap.success) {
      return { success: false, error: swap.error || "Swap failed" };
    }

    // Calculate token quantity and price
    const tokenQty = Number(quote.outAmount) / 1e9; // Assuming 9 decimals
    const pricePerToken = firstTrancheSol / tokenQty;

    LOG.info(
      {
        mint,
        tokenQty,
        pricePerToken,
        signature: swap.signature,
      },
      "First tranche executed successfully"
    );

    return {
      success: true,
      tokenQty,
      pricePerToken,
      signature: swap.signature,
    };
  } catch (err: any) {
    LOG.error({ err: err.message || err }, "First tranche execution failed");
    return { success: false, error: err.message || "Unknown error" };
  }
}

/**
 * Execute test sell (0.5% of received tokens)
 * Used to verify liquidity and trading viability
 */
export async function executeTestSell(
  mint: string,
  tokenQty: number,
  decimals: number,
  wallet: string,
  useReal: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const testSellPct = 0.005; // 0.5%
    const testSellQty = tokenQty * testSellPct;
    const testSellBase = Math.floor(testSellQty * 10 ** decimals);

    LOG.info(
      {
        mint,
        totalTokens: tokenQty,
        testSellQty,
        testSellBase,
        decimals,
      },
      "Executing 0.5% test sell"
    );

    if (!testSellBase || testSellBase <= 0) {
      return { success: false, error: "Test sell amount too small" };
    }

    // Get quote to verify we can sell
    const quote = await getRaydiumQuote(mint, SOL_MINT, testSellBase, 1);
    if (!quote?.outAmount) {
      return { success: false, error: "No quote for test sell - illiquid!" };
    }

    const receivedSol = Number(quote.outAmount) / 1e9;
    if (receivedSol <= 0) {
      return { success: false, error: "Test sell would receive 0 SOL" };
    }

    // Execute test sell
    if (useReal) {
      const swap = await executeRaydiumSwap({
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: testSellBase,
        userPublicKey: wallet,
        slippage: 2, // Higher slippage for small test sell
      });

      if (!swap.success) {
        return { success: false, error: swap.error || "Test sell swap failed" };
      }

      LOG.info(
        {
          mint,
          receivedSol,
          signature: swap.signature,
        },
        "Test sell executed successfully"
      );
    } else {
      LOG.info({ mint, receivedSol }, "Test sell simulated successfully");
    }

    return { success: true };
  } catch (err: any) {
    LOG.error({ err: err.message || err }, "Test sell execution failed");
    return { success: false, error: err.message || "Unknown error" };
  }
}

/**
 * Wait for price pullback before executing second tranche
 * Monitors price for a micro-dip (configurable threshold)
 */
export async function waitForPullback(
  mint: string,
  entryPrice: number,
  timeoutMs: number = 300000 // 5 minutes default
): Promise<{ success: boolean; currentPrice?: number }> {
  const startTime = Date.now();
  const pullbackThreshold = 0.98; // 2% dip from entry

  LOG.info(
    {
      mint,
      entryPrice,
      targetPrice: entryPrice * pullbackThreshold,
      timeoutMs,
    },
    "Waiting for pullback to execute second tranche"
  );

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Check current price with small probe
      const probeAmount = Math.floor(1e6); // 0.001 SOL worth
      const quote = await getRaydiumQuote(SOL_MINT, mint, probeAmount, 1);

      if (quote?.outAmount) {
        const tokenOut = Number(quote.outAmount) / 1e9;
        const currentPrice = probeAmount / 1e9 / tokenOut;

        LOG.debug(
          {
            mint,
            currentPrice,
            entryPrice,
            pullbackPct: ((currentPrice - entryPrice) / entryPrice) * 100,
          },
          "Checking for pullback"
        );

        // If price dipped below threshold, execute second tranche
        if (currentPrice <= entryPrice * pullbackThreshold) {
          LOG.info(
            {
              mint,
              currentPrice,
              entryPrice,
              pullbackPct: ((currentPrice - entryPrice) / entryPrice) * 100,
            },
            "Pullback detected - ready for second tranche"
          );
          return { success: true, currentPrice };
        }
      }

      // Wait 5 seconds before next check
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (err: any) {
      LOG.warn(
        { err: err.message || err },
        "Error checking price for pullback"
      );
    }
  }

  // Timeout - proceed with second tranche anyway
  LOG.warn(
    {
      mint,
      timeoutMs,
    },
    "Pullback timeout - executing second tranche at current price"
  );
  return { success: true }; // Still return success to not block second tranche
}

/**
 * Execute second tranche buy (40% of position)
 */
export async function executeSecondTranche(
  mint: string,
  totalBuySol: number,
  wallet: string,
  isPumpFun: boolean,
  useReal: boolean
): Promise<TrancheResult> {
  try {
    const secondTrancheSol = totalBuySol * 0.4; // 40% of position
    const lamports = Math.floor(secondTrancheSol * 1e9);

    LOG.info(
      {
        mint,
        totalSol: totalBuySol,
        trancheSol: secondTrancheSol,
        isPumpFun,
        useReal,
      },
      "Executing second tranche (40%)"
    );

    // Get quote to estimate token amount with slippage 8-12%
    const slippage = Number(process.env.MAX_SLIPPAGE_PCT || 10); // Default 10%
    const quote = await getRaydiumQuote(SOL_MINT, mint, lamports, slippage);
    if (!quote?.outAmount) {
      return { success: false, error: "No quote for second tranche" };
    }

    // Check if price impact is extreme (>15% = abort)
    if (quote.priceImpactPct && quote.priceImpactPct > 15) {
      return {
        success: false,
        error: `Price impact too high: ${quote.priceImpactPct.toFixed(2)}%`,
      };
    }

    // Execute swap
    let swap: {
      success: boolean;
      signature?: string;
      error?: string;
    };

    if (useReal) {
      if (isPumpFun) {
        const slippageBps = slippage * 100; // Convert to basis points
        const pumpResult = await executePumpFunTrade(
          mint,
          true,
          lamports,
          wallet,
          slippageBps // Use configured slippage
        );
        swap = pumpResult
          ? { success: pumpResult.success, signature: pumpResult.signature }
          : { success: false, error: "Pump.fun second tranche failed" };
      } else {
        swap = await executeRaydiumSwap({
          inputMint: SOL_MINT,
          outputMint: mint,
          amount: lamports,
          userPublicKey: wallet,
          slippage: slippage,
        });
      }
    } else {
      swap = {
        success: true,
        signature: `sim-tranche2-${Date.now()}`,
      };
    }

    if (!swap.success) {
      return { success: false, error: swap.error || "Swap failed" };
    }

    // Calculate token quantity and price
    const tokenQty = Number(quote.outAmount) / 1e9;
    const pricePerToken = secondTrancheSol / tokenQty;

    LOG.info(
      {
        mint,
        tokenQty,
        pricePerToken,
        signature: swap.signature,
      },
      "Second tranche executed successfully"
    );

    return {
      success: true,
      tokenQty,
      pricePerToken,
      signature: swap.signature,
    };
  } catch (err: any) {
    LOG.error({ err: err.message || err }, "Second tranche execution failed");
    return { success: false, error: err.message || "Unknown error" };
  }
}
