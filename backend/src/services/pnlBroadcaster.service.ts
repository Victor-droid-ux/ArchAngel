// backend/src/services/pnlBroadcaster.service.ts
import { Server } from "socket.io";
import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";

const log = getLogger("pnlBroadcaster");

let broadcastInterval: NodeJS.Timeout | null = null;

/**
 * Start broadcasting P&L updates to all connected clients
 */
export function startPnLBroadcaster(
  io: Server,
  opts?: { intervalMs?: number }
) {
  const intervalMs = opts?.intervalMs ?? 30000; // Broadcast every 30 seconds by default

  log.info(`Starting P&L broadcaster (interval: ${intervalMs}ms)`);

  const broadcastPnL = async () => {
    try {
      // Fetch portfolio P&L
      const portfolioPnL = await dbService.getPortfolioPnL();

      // Broadcast to all connected clients
      io.emit("pnl:update", portfolioPnL);

      log.debug("Broadcasted portfolio P&L update");
    } catch (err: any) {
      log.error({ err: err?.message ?? String(err) }, "Error broadcasting P&L");
    }
  };

  // Run initial broadcast
  broadcastPnL();

  // Set up interval
  broadcastInterval = setInterval(broadcastPnL, intervalMs);
}

/**
 * Stop the P&L broadcaster
 */
export function stopPnLBroadcaster() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
    log.info("P&L broadcaster stopped");
  }
}
