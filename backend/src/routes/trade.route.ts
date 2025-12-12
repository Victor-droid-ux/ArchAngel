import express from "express";
import { buyViaRaydium } from "../services/raydium/raydium.buy.service.js";
import {
  getEffectiveConfig,
  shouldTriggerTrade,
} from "../services/traderConfig.service.js";
import db from "../services/db.service.js";
import { getLogger } from "../utils/logger.js";
import {
  getRaydiumQuote,
  buildRaydiumSwapPayload,
} from "../services/raydium.service.js";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { CONFIG } from "../services/raydium/config.js";
import { validateTradeOpportunity } from "../services/tradeValidation.service.js";
import { executeManualBuy } from "../services/manualBuy.service.js";

const logger = getLogger("trade.route");
const router = express.Router();

/**
 * POST /api/trade/validate
 * body: { tokenMint }
 * Returns validation result for 3 critical conditions
 */
router.post("/validate", async (req, res) => {
  try {
    const { tokenMint } = req.body;
    if (!tokenMint) {
      return res
        .status(400)
        .json({ success: false, message: "Missing tokenMint" });
    }

    const validation = await validateTradeOpportunity(tokenMint);
    return res.json({ success: true, validation });
  } catch (error: any) {
    logger.error(`Validation error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/trade/manual-buy
 * body: { tokenMint, amountSol, slippage?, wallet? }
 * NO VALIDATIONS - User discretion only (DYOR)
 */
router.post("/manual-buy", async (req, res) => {
  try {
    const { tokenMint, amountSol, slippage, wallet } = req.body;

    if (!tokenMint || !amountSol) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: tokenMint, amountSol",
      });
    }

    logger.info(
      `⚠️ Manual buy request: ${amountSol} SOL for ${tokenMint.slice(
        0,
        8
      )}... (NO VALIDATIONS)`
    );

    // Execute manual buy with NO validations
    const result = await executeManualBuy({
      tokenMint,
      amountSol,
      slippage:
        slippage ||
        parseFloat(process.env.MANUAL_BUY_DEFAULT_SLIPPAGE_PCT || "10"),
      reason: "manual_ui",
      wallet,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || "Manual buy failed",
      });
    }

    // Store trade in database
    const trade = await db.addTrade({
      type: "buy",
      token: tokenMint,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: tokenMint,
      amount: Math.floor(amountSol * 1e9),
      price: result.pricePerToken || 0,
      pnl: 0,
      wallet: wallet || process.env.WALLET_PUBLIC_KEY || "",
      simulated: false,
      signature: result.signature || null,
      route: "raydium",
      timestamp: new Date(),
    });

    // Broadcast via socket
    const io = (req.app as any)?.get?.("io") ?? (req.app as any)?.locals?.io;
    io?.emit?.("tradeFeed", trade);

    logger.info(`✅ Manual buy executed: ${result.signature}`);

    return res.json({
      success: true,
      data: {
        ...result,
        trade,
      },
    });
  } catch (error: any) {
    logger.error(`Manual buy error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: error.message || "Manual buy failed",
    });
  }
});

/**
 * POST /api/trade
 * body: { type, inputMint, outputMint, amount, wallet, slippage }
 * Supports both Raydium and Pump.fun trading
 */
router.post("/", async (req, res) => {
  try {
    const {
      type,
      inputMint,
      outputMint,
      amount,
      wallet,
      slippage,
      skipValidation,
    } = req.body;
    if (!type || !outputMint || !amount || !wallet) {
      return res
        .status(400)
        .json({ success: false, message: "Missing params" });
    }

    // Determine the token mint (for buy it's outputMint, for sell it's inputMint)
    const tokenMint = type === "buy" ? outputMint : inputMint;

    // ✨ NEW: Validate with 3 critical conditions (only for buys, can be skipped)
    if (type === "buy" && !skipValidation) {
      logger.info(`🔍 Validating manual trade for ${tokenMint.slice(0, 8)}...`);
      const validation = await validateTradeOpportunity(tokenMint);

      if (!validation.approved) {
        logger.warn(`⚠️ Trade validation failed: ${validation.reason}`);
        return res.status(400).json({
          success: false,
          message: validation.reason,
          validation,
        });
      }

      logger.info(`✅ Trade validation passed - proceeding with manual buy`);
    }

    // if USE_REAL_SWAP true -> call appropriate swap; else simulate
    if (process.env.USE_REAL_SWAP === "true") {
      // Execute Raydium trade only
      logger.info(
        `Executing manual ${type} on Raydium for ${tokenMint.slice(0, 8)}...`
      );
      const result = await buyViaRaydium({
        inputMint,
        outputMint,
        amountLamports: amount,
        userPubkey: wallet,
      });

      if (!result.success) throw new Error(`Raydium swap failed`);

      // calculate price from outAmount
      const price = result.outAmount
        ? Number((amount / result.outAmount).toFixed(9))
        : 0;
      // store trade & emit
      const trade = await db.addTrade({
        type,
        token: outputMint,
        inputMint,
        outputMint,
        amount,
        price,
        pnl: 0,
        wallet,
        simulated: false,
        signature: result.signature,
        route: "raydium",
      });
      // broadcast via socket if available
      const io = (req.app as any)?.get?.("io") ?? (req.app as any)?.locals?.io;
      io?.emit?.("tradeFeed", trade);
      return res.json({ success: true, data: trade, route: "raydium" });
    } else {
      // simulate
      const pnl = Math.random() * 0.05 - 0.02;
      const price = Number((Math.random() * 0.002 + 0.0005).toFixed(6));
      const signature = "sim-" + Date.now();
      const trade = await db.addTrade({
        type,
        token: outputMint,
        inputMint,
        outputMint,
        amount,
        price,
        pnl,
        wallet,
        simulated: true,
        signature,
        timestamp: new Date(),
      });
      const io = (req.app as any)?.get?.("io") ?? (req.app as any)?.locals?.io;
      io?.emit?.("tradeFeed", trade);
      return res.json({ success: true, data: trade, simulated: true });
    }
  } catch (err: any) {
    logger.error("Trade error: " + String(err));
    res
      .status(500)
      .json({ success: false, message: err.message || String(err) });
  }
});

/**
 * POST /api/trade/prepare
 * Prepare an unsigned transaction for the frontend to sign
 * Supports both Raydium and pump.fun tokens
 */
router.post("/prepare", async (req, res) => {
  try {
    const {
      type,
      inputMint,
      outputMint,
      wallet,
      amountLamports,
      slippageBps,
      forceRaydium,
    } = req.body;

    if (!type || !outputMint || !wallet || !amountLamports) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }

    // Get the token mint (for buy it's outputMint, for sell it's inputMint)
    const tokenMint = type === "buy" ? outputMint : inputMint;
    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // Set default mints if not provided
    const finalInputMint = inputMint || (type === "buy" ? SOL_MINT : tokenMint);
    const finalOutputMint =
      outputMint || (type === "sell" ? SOL_MINT : tokenMint);

    // Check trader config to see if trade should trigger
    const config = await getEffectiveConfig(wallet, tokenMint);

    // Raydium-only flow
    logger.info(
      `Preparing Raydium ${type} trade for token ${tokenMint.slice(0, 8)}...`
    );

    // Get Raydium quote with fast mode enabled for manual trades (reduces timeout risk)
    const quote = await getRaydiumQuote(
      finalInputMint,
      finalOutputMint,
      amountLamports,
      slippageBps ? slippageBps / 100 : 1,
      true // fastMode: use 3 retries instead of 20 to prevent timeout
    );

    if (!quote) {
      const errorMessage = "No Raydium liquidity pool found for this token.";
      const suggestion =
        "Verify the token address is correct and has sufficient liquidity on Raydium.";

      logger.error(
        `No Raydium quote available for ${tokenMint.slice(
          0,
          8
        )}... - ${errorMessage}`
      );

      return res.status(400).json({
        success: false,
        message: `${errorMessage} ${suggestion}`,
        tokenAddress: tokenMint,
        dexScreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
        canRetry: false,
      });
    }

    // Build unsigned transaction
    const { swapTransaction } = await buildRaydiumSwapPayload(quote, wallet);

    logger.info(`Prepared Raydium ${type} transaction for ${wallet}`);

    return res.json({
      success: true,
      data: {
        transaction: swapTransaction,
        config: config,
        quote: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          inAmount: quote.inAmount,
          slippageBps: quote.slippageBps,
        },
      },
    });
  } catch (err: any) {
    logger.error("Prepare trade error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * POST /api/trade/confirm
 * Confirm and execute a signed transaction (Raydium only)
 */
router.post("/confirm", async (req, res) => {
  try {
    const {
      signedTransaction,
      type,
      token,
      amountLamports,
      takeProfit,
      stopLoss,
      wallet,
      slippageBps,
    } = req.body;

    if (!type || !token || !amountLamports) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }

    if (!signedTransaction) {
      return res.status(400).json({
        success: false,
        message: "Signed transaction required for Raydium trades",
      });
    }

    let signature: string;
    let price: number;

    // Raydium-only flow: deserialize and send signed transaction
    logger.info(
      `Executing Raydium ${type} trade for token ${token.slice(0, 8)}...`
    );

    const connection = new Connection(CONFIG.RPC_URL, "confirmed");
    const txBuffer = Buffer.from(signedTransaction, "base64");
    const versionedTx = VersionedTransaction.deserialize(txBuffer);

    // Send transaction to Solana
    signature = await connection.sendTransaction(versionedTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    logger.info(`Raydium transaction sent: ${signature}`);

    // Confirm transaction
    const latestBlockhash = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    // Calculate price from transaction (simplified - in production, parse transaction logs)
    price = Number((Math.random() * 0.002 + 0.0005).toFixed(6));

    // Record trade in database
    const pnl = 0; // Will be calculated later based on position tracking

    const trade = await db.addTrade({
      type,
      token: token,
      inputMint:
        type === "buy" ? "So11111111111111111111111111111111111111112" : token,
      outputMint:
        type === "buy" ? token : "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      price,
      pnl,
      wallet: wallet || "unknown",
      simulated: false,
      signature,
      timestamp: new Date(),
    });

    // Broadcast via socket
    const io = (req.app as any)?.get?.("io") ?? (req.app as any)?.locals?.io;
    io?.emit?.("tradeFeed", trade);

    logger.info(`Confirmed ${type} trade (Raydium): ${signature}`);

    return res.json({
      success: true,
      data: {
        ...trade,
        takeProfit,
        stopLoss,
      },
    });
  } catch (err: any) {
    logger.error("Confirm trade error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * POST /api/trade/calculate-risk
 * Calculate trade size based on risk parameters
 * Body: { balance, riskPercent, riskAmount }
 */
router.post("/calculate-risk", async (req, res) => {
  try {
    const { balance, riskPercent, riskAmount } = req.body;

    if (!balance || typeof balance !== "number") {
      return res.status(400).json({
        success: false,
        message: "Balance is required and must be a number",
      });
    }

    let calculatedAmount = 0;
    let calculatedPercent = 0;

    // If risk amount is provided, use it directly
    if (riskAmount && typeof riskAmount === "number" && riskAmount > 0) {
      calculatedAmount = riskAmount;
      calculatedPercent = (riskAmount / balance) * 100;
    }
    // If risk percent is provided, calculate amount from percentage
    else if (
      riskPercent &&
      typeof riskPercent === "number" &&
      riskPercent > 0
    ) {
      calculatedPercent = riskPercent;
      calculatedAmount = (balance * riskPercent) / 100;
    }
    // Default to 1% of balance
    else {
      calculatedPercent = 1;
      calculatedAmount = balance * 0.01;
    }

    // Cap at 100% of balance
    if (calculatedAmount > balance) {
      calculatedAmount = balance;
      calculatedPercent = 100;
    }

    // Ensure minimum trade size (0.001 SOL)
    if (calculatedAmount < 0.001) {
      calculatedAmount = 0.001;
      calculatedPercent = (0.001 / balance) * 100;
    }

    logger.info(
      `Risk calculation: Balance=${balance.toFixed(
        4
      )} SOL, Risk=${calculatedPercent.toFixed(
        2
      )}%, Amount=${calculatedAmount.toFixed(4)} SOL`
    );

    return res.json({
      success: true,
      data: {
        balance,
        riskPercent: Number(calculatedPercent.toFixed(2)),
        riskAmount: Number(calculatedAmount.toFixed(4)),
        amountLamports: Math.floor(calculatedAmount * 1e9),
        recommendation: {
          conservative: Number((balance * 0.01).toFixed(4)), // 1%
          moderate: Number((balance * 0.025).toFixed(4)), // 2.5%
          aggressive: Number((balance * 0.05).toFixed(4)), // 5%
        },
      },
    });
  } catch (err: any) {
    logger.error("Risk calculation error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * Pool monitoring endpoints removed - Raydium-only system
 */

export default router;
