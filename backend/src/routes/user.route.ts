// backend/src/routes/user.route.ts
import express from "express";
import { getLogger } from "../utils/logger.js";

const router = express.Router();
const log = getLogger("user.route");

// NOTE: UserSettings persistence was removed with db.service.ts simplification
// User settings (autoMode, manualAmountSol) are now only stored in-memory via socket
// These endpoints are kept as stubs for backward compatibility

// POST /api/user/settings
router.post("/settings", async (req, res) => {
  try {
    const { wallet, autoMode, manualAmountSol } = req.body;
    if (!wallet)
      return res
        .status(400)
        .json({ success: false, message: "wallet required" });

    // User settings no longer persisted - return success for compatibility
    log.info(
      { wallet, autoMode, manualAmountSol },
      "User settings received (not persisted)"
    );

    return res.json({
      success: true,
      data: { wallet, autoMode, manualAmountSol, updatedAt: new Date() },
      message: "Settings are stored in-memory only via socket connection",
    });
  } catch (err: any) {
    log.error("save settings failed: " + String(err));
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/user/settings?wallet=...
router.get("/settings", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "");
    if (!wallet)
      return res
        .status(400)
        .json({ success: false, message: "wallet query required" });

    // Return default settings since persistence was removed
    log.info({ wallet }, "User settings requested (returning defaults)");

    return res.json({
      success: true,
      data: { wallet, autoMode: false, manualAmountSol: null },
      message: "Settings are stored in-memory only via socket connection",
    });
  } catch (err: any) {
    log.error("get user settings failed: " + String(err));
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
