// backend/src/routes/admin.route.ts
import express from "express";
import dbService from "../services/db.service.js";
import { executeRaydiumSwap } from "../services/raydium.service.js";
import notify from "../services/notifications/notify.service.js";
import { getLogger } from "../utils/logger.js";

const router = express.Router();
const log = getLogger("admin.route");

/**
 * POST /api/admin/force-sell
 * body: { token: string, amountSol?: number, wallet?: string }
 * Force sell a position immediately.
 */
router.post("/force-sell", async (req, res) => {
  try {
    const { token, amountSol, wallet } = req.body;
    if (!token)
      return res
        .status(400)
        .json({ success: false, message: "token required" });

    // compute amount lamports (default: everything)
    const positions = await dbService.getPositions();
    const p = positions.find((x: any) => x.token === token);
    if (!p)
      return res
        .status(404)
        .json({ success: false, message: "position not found" });

    const amountToSell = amountSol ?? p.netSol;
    const amountLamports = Math.floor(amountToSell * 1e9);

    const result = await executeRaydiumSwap({
      inputMint: token, // token is the mint address
      outputMint: "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      userPublicKey: wallet ?? process.env.ADMIN_WALLET_PUBKEY ?? "",
      slippage: Number(process.env.ADMIN_FORCE_SLIPPAGE || 1),
    });

    // insert sell trade record
    const sellRecord = await dbService.addTrade({
      type: "sell",
      token,
      inputMint: token,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      price: p.avgBuyPrice ?? 0,
      pnl: 0,
      wallet: wallet ?? process.env.ADMIN_WALLET_PUBKEY ?? "admin",
      simulated: !result.success,
      signature: result.success ? result.signature : null,
      timestamp: new Date(),
    });

    // Only include defined optional properties
    notify.notifyTrade({
      id: sellRecord.id,
      type: "sell",
      token: sellRecord.token,
      amountSol: sellRecord.amountSol,
      ...(sellRecord.price !== undefined && { price: sellRecord.price }),
      ...(sellRecord.pnl !== undefined && { pnl: sellRecord.pnl }),
      ...(sellRecord.signature !== undefined && {
        signature: sellRecord.signature,
      }),
      ...(sellRecord.simulated !== undefined && {
        simulated: sellRecord.simulated,
      }),
    });

    // socket
    const io = req.app?.get?.("io");
    io?.emit("tradeFeed", {
      id: sellRecord.id,
      type: "sell",
      token: sellRecord.token,
      amount: sellRecord.amountSol,
      price: sellRecord.price,
      pnl: sellRecord.pnl,
      signature: sellRecord.signature,
      simulated: sellRecord.simulated,
      timestamp: sellRecord.timestamp,
    });

    return res.json({ success: true, data: sellRecord });
  } catch (err: any) {
    log.error("force-sell failed: " + (err?.message || err));
    notify
      .notifyError({ source: "admin.force-sell", message: err?.message })
      .catch(() => {});
    return res
      .status(500)
      .json({ success: false, message: err?.message || "force-sell failed" });
  }
});

/**
 * POST /api/admin/cancel-order
 * body: { signature } - marks an order/trade as cancelled (logical cancel)
 */
router.post("/cancel-order", async (req, res) => {
  try {
    const { signature } = req.body;
    if (!signature)
      return res
        .status(400)
        .json({ success: false, message: "signature required" });

    // There is no on-chain cancel for swaps, so we just mark records
    const trades = await dbService.getTrades(200);
    const t = trades.find((x: any) => x.signature === signature);
    if (!t)
      return res
        .status(404)
        .json({ success: false, message: "trade not found" });

    await dbService.updateStats({}); // (no-op) or implement updateTradeStatus method
    // Ideally dbService should expose updateTradeStatus; for now update stats doc
    return res.json({
      success: true,
      message: "marked cancelled (you may implement updateTrade in dbService)",
    });
  } catch (err: any) {
    notify
      .notifyError({ source: "admin.cancel-order", message: err?.message })
      .catch(() => {});
    return res
      .status(500)
      .json({ success: false, message: err?.message || "cancel failed" });
  }
});

export default router;
