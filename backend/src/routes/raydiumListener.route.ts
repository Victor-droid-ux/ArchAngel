// backend/src/routes/raydiumListener.route.ts
import express from "express";
import { raydiumPoolListener } from "../services/raydiumPoolListener.service.js";
import { getLogger } from "../utils/logger.js";

const LOG = getLogger("raydium-listener-route");
const router = express.Router();

/**
 * GET /api/raydium-listener/status
 * Get current listener status
 */
router.get("/status", async (req, res) => {
  try {
    const status = raydiumPoolListener.getStatus();
    return res.json({ success: true, status });
  } catch (error: any) {
    LOG.error(`Error getting status: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/raydium-listener/start
 * Start the pool listener
 */
router.post("/start", async (req, res) => {
  try {
    await raydiumPoolListener.startListening();
    LOG.info("Pool listener started via API");
    return res.json({ success: true, message: "Pool listener started" });
  } catch (error: any) {
    LOG.error(`Error starting listener: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/raydium-listener/stop
 * Stop the pool listener
 */
router.post("/stop", async (req, res) => {
  try {
    await raydiumPoolListener.stopListening();
    LOG.info("Pool listener stopped via API");
    return res.json({ success: true, message: "Pool listener stopped" });
  } catch (error: any) {
    LOG.error(`Error stopping listener: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/raydium-listener/config
 * Update listener configuration
 */
router.post("/config", async (req, res) => {
  try {
    const updates = req.body;
    raydiumPoolListener.updateConfig(updates);
    LOG.info("Pool listener config updated", updates);
    return res.json({ success: true, message: "Configuration updated" });
  } catch (error: any) {
    LOG.error(`Error updating config: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
