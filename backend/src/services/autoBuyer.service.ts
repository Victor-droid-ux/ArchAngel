// backend/src/services/autoBuyer.service.ts
import crypto from "crypto";
import { Server } from "socket.io";
import { getRaydiumQuote, executeRaydiumSwap } from "./raydium.service.js";
import { getPumpFunQuote, executePumpFunTrade } from "./pumpfun.service.js";
import dbService, { TradeRecord } from "./db.service.js";
import { getLogger } from "../utils/logger.js";
import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import { hasSufficientBalance } from "./solana.service.js";
import { validateTradeOpportunity } from "./tradeValidation.service.js";
import { observeMarketBehavior } from "./marketBehavior.service.js";
import strategyEngine from "../strategies/index.js";
import { getTokenHistory } from "../strategies/utils.js";
import { canExecuteTrade } from "./riskManagement.service.js";
import {
  executeFirstTranche,
  executeTestSell,
  waitForPullback,
  executeSecondTranche,
} from "./trancheBuyer.service.js";

const LOG = getLogger("autoBuyer");
import { ENV } from "../utils/env.js";

// Returns true if mint is in list (case-insensitive)
function isInList(mint: string, list: string[]): boolean {
  return list.some((addr) => addr.trim().toLowerCase() === mint.toLowerCase());
}

// Returns true if token is within the allowed launch window
function isWithinLaunchWindow(token: any): boolean {
  if (!token || !token.pairCreatedAt) return true; // If no launch time, allow
  const now = Date.now();
  const launch = Number(token.pairCreatedAt);
  const ageSec = (now - launch) / 1000;
  return (
    ageSec >= ENV.MIN_SECONDS_SINCE_LAUNCH &&
    ageSec <= ENV.MAX_SECONDS_SINCE_LAUNCH
  );
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

/* ---------------- RPC for token decimals (Helius preferred) ---------------- */
const SOLANA_RPC =
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL) || "https://api.mainnet-beta.solana.com";

const commitment: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) || "confirmed";

const connection = new Connection(SOLANA_RPC, commitment);

const decimalsCache = new Map<string, number>();

async function getDecimals(mint: string): Promise<number> {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint)!;

  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const d =
      (info.value?.data as any)?.parsed?.info?.decimals ??
      (info.value?.data as any)?.info?.decimals ??
      9;

    const num = Number(d);
    decimalsCache.set(mint, num);
    return num;
  } catch (err) {
    LOG.warn({ mint }, "Fallback decimals=9 for");
    decimalsCache.set(mint, 9);
    return 9;
  }
}

/* ------------------------------------------------------------------------
   AUTO BUY EXECUTOR (triggered by token discovery)
------------------------------------------------------------------------ */
export async function registerAutoBuyCandidate(io: Server, token: any) {
  // === Blacklist/Whitelist Filtering ===
  const mint = token.mint;
  if (!mint) return;
  if (ENV.TOKEN_BLACKLIST.length && isInList(mint, ENV.TOKEN_BLACKLIST)) {
    LOG.warn({ mint }, "⛔ Skipping blacklisted token");
    io.emit("tradeError", {
      type: "blacklist",
      mint,
      reason: "Token is blacklisted",
      message: "Token is blacklisted",
    });
    return;
  }
  if (ENV.TOKEN_WHITELIST.length && !isInList(mint, ENV.TOKEN_WHITELIST)) {
    LOG.warn({ mint }, "⛔ Skipping non-whitelisted token");
    io.emit("tradeError", {
      type: "whitelist",
      mint,
      reason: "Token is not whitelisted",
      message: "Token is not whitelisted",
    });
    return;
  }

  // === Time-based Entry Filtering ===
  if (!isWithinLaunchWindow(token)) {
    LOG.warn(
      { mint },
      `⏳ Skipping: not within launch window (${ENV.MIN_SECONDS_SINCE_LAUNCH}-${ENV.MAX_SECONDS_SINCE_LAUNCH}s)`
    );
    io.emit("tradeError", {
      type: "launch_window",
      mint,
      reason: `Not within launch window (${ENV.MIN_SECONDS_SINCE_LAUNCH}-${ENV.MAX_SECONDS_SINCE_LAUNCH}s)`,
      message: `Not within launch window (${ENV.MIN_SECONDS_SINCE_LAUNCH}-${ENV.MAX_SECONDS_SINCE_LAUNCH}s)`,
    });
    return;
  }

  try {
    // --- STRATEGY ENGINE: Evaluate all strategies before validation ---
    LOG.info({ mint }, "⚡ Evaluating trading strategies...");
    const { priceHistory, liquidityHistory, volumeHistory } =
      await getTokenHistory(mint);
    const strategyContext = {
      mint,
      priceHistory,
      liquidityHistory,
      volumeHistory,
      currentPrice: token.priceSol ?? 0,
      currentLiquidity: token.liquiditySOL ?? token.liquidity ?? 0,
      currentVolume: token.volume24h ?? 0,
      tokenMeta: token,
    };
    const strategyResult = await strategyEngine.getBestSignal(strategyContext);
    if (!strategyResult || !strategyResult.shouldBuy) {
      LOG.info(
        { mint, reason: strategyResult?.reason },
        "⏭️ No strategy signaled a buy"
      );
      io.emit("tradeError", {
        type: "strategy_blocked",
        mint,
        reason: strategyResult?.reason || "No strategy signaled a buy",
        message: strategyResult?.reason || "No strategy signaled a buy",
      });
      return;
    }
    LOG.info(
      { mint, strategy: strategyResult.reason },
      "✅ Strategy signaled a buy, proceeding to validation..."
    );

    // --- Continue with existing validation pipeline ---
    LOG.info({ mint }, "🔍 Validating token with 3 CRITICAL CONDITIONS...");
    const validation = await validateTradeOpportunity(mint);
    io.emit("validationResult", {
      ...validation,
      token: {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        logoUri: token.logoUri,
        marketCapSol: token.marketCapSol,
        priceSol: token.priceSol,
        lifecycleStage: token.lifecycleStage,
      },
    });
    if (!validation.approved) {
      LOG.info(
        {
          mint,
          recommendation: validation.recommendation,
          reason: validation.reason,
        },
        `⏭️ Skipping trade: ${validation.reason}`
      );
      return;
    }

    LOG.info(
      { mint },
      "✅ All 3 conditions PASSED - Checking market behavior..."
    );

    // STAGE 5: 30-Second Market Behavior Observation
    const poolAddress = validation.raydiumMetrics.poolAddress || "";
    const behaviorMetrics = await observeMarketBehavior(mint, poolAddress);

    if (!behaviorMetrics.allChecksPassed) {
      LOG.info({ mint }, `⏭️ Skipping trade: Failed 30-second behavior check`);
      await dbService.blacklistToken(
        mint,
        "Failed 30-second market behavior observation"
      );
      return;
    }

    LOG.info({ mint }, "✅ Market behavior check PASSED");

    // Prepare trade parameters
    const buySol = Number(process.env.BUY_AMOUNT_SOL ?? 0.1);
    const lamports = Math.round(buySol * 1e9);
    const wallet =
      process.env.BACKEND_RECEIVER_WALLET ||
      process.env.SERVER_PUBLIC_KEY ||
      "";
    const decimals = await getDecimals(mint);
    const base = 10 ** decimals;

    // STAGE 6: Risk Management Check

    const riskCheck = await canExecuteTrade(buySol, wallet);
    if (!riskCheck.allowed) {
      LOG.warn(
        { mint, reason: riskCheck.reason },
        `⏭️ Skipping trade: Risk limit exceeded`
      );
      io.emit("tradeError", {
        type: "risk_limit",
        mint,
        reason: riskCheck.reason,
        message: riskCheck.reason,
      });
      return;
    }

    LOG.info(
      { mint, buySol, openPositions: riskCheck.currentRisk.openPositions },
      "✅ Risk check PASSED - Proceeding with buy execution"
    );

    // Determine trading route based on lifecycle stage
    const lifecycleStage = token.lifecycleStage || "unknown";
    const isPumpFun = lifecycleStage === "pump_fun_bonding";

    LOG.info(
      { mint, lifecycleStage, route: isPumpFun ? "Pump.fun" : "Raydium" },
      "Auto-buy routing decision"
    );

    // Get quote from appropriate DEX
    let quote: { outAmount: number } | null = null;
    if (isPumpFun) {
      quote = await getPumpFunQuote(mint, lamports, true);
      if (!quote) {
        LOG.info({ mint }, "Not tradable / no Pump.fun quote");
        return;
      }
    } else {
      quote = await getRaydiumQuote(SOL_MINT, mint, lamports, 1);
      if (!quote?.outAmount) {
        LOG.info({ mint }, "Not tradable / no Raydium quote");
        return;
      }
    }

    // wallet already declared earlier - verify it's set
    if (!wallet) {
      LOG.error("AUTO BUY FAILED → Wallet not configured");
      return;
    }

    const useReal = process.env.USE_REAL_SWAP === "true";

    // Check wallet balance before attempting trade (skip in simulation mode)
    if (useReal) {
      const hasBalance = await hasSufficientBalance(wallet, buySol);
      if (!hasBalance) {
        LOG.warn(
          {
            wallet,
            requiredSol: buySol,
            mint,
          },
          "Insufficient balance for auto-buy"
        );
        io.emit("tradeError", {
          type: "insufficient_balance",
          mint,
          required: buySol,
          message: `Insufficient balance for ${buySol} SOL trade`,
        });
        return;
      }
    } else {
      LOG.info(
        { mint, route: isPumpFun ? "Pump.fun" : "Raydium" },
        "Simulation mode: bypassing balance check"
      );
    }
    // ✨ RULE 8: 2-TRANCHE BUYING STRATEGY
    LOG.info({ mint, buySol }, "📊 Executing 2-tranche buy (60% + 40%)");

    // TRANCHE 1: Buy 60% of position
    const tranche1Result = await executeFirstTranche(
      mint,
      buySol,
      wallet,
      isPumpFun,
      useReal
    );

    if (!tranche1Result.success) {
      LOG.error(
        { mint, error: tranche1Result.error },
        "First tranche failed - aborting buy"
      );
      io.emit("tradeError", {
        type: "tranche1_failed",
        mint,
        error: tranche1Result.error,
        message: "First tranche (60%) failed",
      });
      return;
    }

    const firstTokenQty = tranche1Result.tokenQty || 0;
    const firstPrice = tranche1Result.pricePerToken || 0;

    LOG.info(
      {
        mint,
        tokenQty: firstTokenQty,
        price: firstPrice,
        signature: tranche1Result.signature,
      },
      "✅ First tranche (60%) executed"
    );

    // TEST SELL: Verify liquidity with 0.5% sell
    LOG.info({ mint }, "🧪 Executing 0.5% test sell to verify liquidity...");

    // decimals already declared earlier
    const testSellResult = await executeTestSell(
      mint,
      firstTokenQty,
      decimals,
      wallet,
      useReal
    );

    if (!testSellResult.success) {
      LOG.error(
        { mint, error: testSellResult.error },
        "❌ TEST SELL FAILED - EMERGENCY EXIT!"
      );

      // Emergency exit: sell ALL tokens from first tranche
      if (useReal && firstTokenQty > 0) {
        const emergencyBase = Math.floor(firstTokenQty * 10 ** decimals);
        LOG.warn(
          { mint, tokenQty: firstTokenQty },
          "⚠️ Emergency selling all tokens from first tranche"
        );

        try {
          const emergencySwap = await executeRaydiumSwap({
            inputMint: mint,
            outputMint: SOL_MINT,
            amount: emergencyBase,
            userPublicKey: wallet,
            slippage: 5, // Higher slippage for emergency
          });

          if (emergencySwap.success) {
            LOG.info(
              { mint, signature: emergencySwap.signature },
              "Emergency exit completed"
            );
            io.emit("tradeError", {
              type: "test_sell_failed_emergency_exit",
              mint,
              reason: testSellResult.error,
              emergencyExitSignature: emergencySwap.signature,
            });
          } else {
            LOG.error(
              { mint, error: emergencySwap.error },
              "Emergency exit failed!"
            );
          }
        } catch (emergencyErr: any) {
          LOG.error(
            { mint, err: emergencyErr.message || emergencyErr },
            "Emergency exit exception"
          );
        }
      }

      return; // Abort - do not proceed to second tranche
    }

    LOG.info({ mint }, "✅ Test sell passed - liquidity verified");

    // Record first tranche trade
    const base1 = 10 ** decimals;
    const trade1 = {
      id: crypto.randomUUID(),
      type: "buy" as const,
      token: mint,
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: Math.floor(buySol * 0.6 * 1e9), // 60% in lamports
      price: firstPrice,
      pnl: 0,
      wallet,
      simulated: !useReal,
      signature: tranche1Result.signature ?? null,
      timestamp: new Date(),
    };

    await dbService.addTrade(trade1);
    await dbService.updatePositionMetadata(mint, {
      firstTrancheEntry: Date.now(),
      remainingPct: 100, // Full position after first buy
    });

    io.emit("tradeFeed", {
      ...trade1,
      auto: true,
      reason: "tranche1_buy",
      route: isPumpFun ? "pump.fun" : "raydium",
      tranche: "1 of 2 (60%)",
    });

    LOG.info({ mint }, "💤 Waiting for pullback before second tranche...");

    // Wait for pullback (2% dip or 5-minute timeout)
    const pullbackResult = await waitForPullback(mint, firstPrice, 300000);

    // TRANCHE 2: Buy remaining 40%
    LOG.info({ mint }, "📊 Executing second tranche (40%)");

    const tranche2Result = await executeSecondTranche(
      mint,
      buySol,
      wallet,
      isPumpFun,
      useReal
    );

    if (!tranche2Result.success) {
      LOG.warn(
        { mint, error: tranche2Result.error },
        "Second tranche failed - continuing with first tranche only"
      );
      // Not a critical failure - we still have 60% position
      return;
    }

    const secondTokenQty = tranche2Result.tokenQty || 0;
    const secondPrice = tranche2Result.pricePerToken || 0;

    LOG.info(
      {
        mint,
        tokenQty: secondTokenQty,
        price: secondPrice,
        signature: tranche2Result.signature,
      },
      "✅ Second tranche (40%) executed"
    );

    // Record second tranche trade
    const trade2 = {
      id: crypto.randomUUID(),
      type: "buy" as const,
      token: mint,
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: Math.floor(buySol * 0.4 * 1e9), // 40% in lamports
      price: secondPrice,
      pnl: 0,
      wallet,
      simulated: !useReal,
      signature: tranche2Result.signature ?? null,
      timestamp: new Date(),
    };

    await dbService.addTrade(trade2);
    await dbService.updatePositionMetadata(mint, {
      secondTrancheEntry: Date.now(),
    });

    io.emit("tradeFeed", {
      ...trade2,
      auto: true,
      reason: "tranche2_buy",
      route: isPumpFun ? "pump.fun" : "raydium",
      tranche: "2 of 2 (40%)",
    });

    // Calculate weighted average entry price
    const totalTokens = firstTokenQty + secondTokenQty;
    const avgPrice =
      (firstTokenQty * firstPrice + secondTokenQty * secondPrice) / totalTokens;

    LOG.info(
      {
        mint,
        totalTokens,
        avgPrice,
        tranche1Price: firstPrice,
        tranche2Price: secondPrice,
      },
      "🎯 2-tranche buy completed successfully"
    );

    // Both tranches completed successfully
    return trade2; // Return second tranche trade as final confirmation
  } catch (err: any) {
    LOG.error({ err: err.message ?? err }, "AutoBuyer error");
    return null;
  }
}
