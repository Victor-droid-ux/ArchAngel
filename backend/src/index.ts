// backend/src/index.ts
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";

import tradeRoutes from "./routes/trade.route.js";
import statsRoutes from "./routes/stats.route.js";
import tokensRoutes from "./routes/tokens.route.js";
import positionsRoutes from "./routes/positions.route.js";
import watchlistRoutes from "./routes/watchlist.route.js";
import pnlRoutes from "./routes/pnl.route.js";
import cacheRoutes from "./routes/cache.route.js";
import configRoutes from "./routes/config.route.js";
import traderConfigRoutes from "./routes/traderConfig.route.js";
import raydiumListenerRoutes from "./routes/raydiumListener.route.js";

import { registerSocketHandlers } from "./routes/socket.route.js";

import dbService from "./services/db.service.js";
import { startTokenPriceService } from "./services/tokenPrice.service.js";
import { startTokenWatcher as startSimpleTokenWatcher } from "./services/token-watcher.js";
import { startTokenWatcher } from "./services/tokenDiscovery.service.js";
import { startPositionMonitor } from "./services/monitor.service.js";
import { startPriceAlertMonitor } from "./services/priceAlert.service.js";
import { startPnLBroadcaster } from "./services/pnlBroadcaster.service.js";
import { getLogger } from "./utils/logger.js";
import { fetchHeliusPrices } from "./services/swap.service.js";
import adminRoutes from "./routes/admin.route.js";
import userRoutes from "./routes/user.route.js";
import { ENV } from "./utils/env.js";
import { raydiumPoolListener } from "./services/raydiumPoolListener.service.js";
import storedTokenChecker from "./services/storedTokenChecker.service.js";

const log = getLogger("index");

(async () => {
  try {
    await dbService.connect();
    log.info("✅ MongoDB connected");
  } catch (err: any) {
    log.error("❌ Failed to connect to DB: " + String(err));
    process.exit(1);
  }

  const app = express();

  app.use(
    cors({
      origin: ENV.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
      credentials: true,
    })
  );

  app.use(express.json());

  app.get("/", (_, res) =>
    res.json({ message: "🚀 ArchAngel Backend Running" })
  );

  app.use("/api/trade", tradeRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/tokens", tokensRoutes);
  app.use("/api/positions", positionsRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/watchlist", watchlistRoutes);
  app.use("/api/pnl", pnlRoutes);
  app.use("/api/cache", cacheRoutes);
  app.use("/api/config", configRoutes);
  app.use("/api/trader-config", traderConfigRoutes);
  app.use("/api/raydium-listener", raydiumListenerRoutes);

  // Debug middleware for unmatched routes
  app.use((req, res, next) => {
    log.warn({ method: req.method, path: req.path }, "Unmatched route");
    next();
  });

  const server = http.createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: ENV.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
    },
  });

  app.set("io", io);
  app.locals.io = io; // Make io available to routes
  app.locals.io = io;
  (globalThis as any).__IO = io;

  registerSocketHandlers(io);

  // ⚠️ DISABLED: Old DexScreener-based token discovery (use Raydium pool listener instead)
  // const discoveryInterval = Number(
  //   process.env.TOKEN_DISCOVERY_INTERVAL_MS ?? 30000
  // );
  // startTokenWatcher(io, { intervalMs: discoveryInterval });

  // Start position monitor for tracking open trades
  startPositionMonitor(io);

  // Start price alert monitor for watchlist notifications
  startPriceAlertMonitor(io, { intervalMs: 60000 }); // Check every minute

  // Start P&L broadcaster for periodic portfolio updates
  startPnLBroadcaster(io, { intervalMs: 30000 }); // Broadcast every 30 seconds

  // Start Raydium pool listener for real-time new pool detection
  if (process.env.RAYDIUM_POOL_LISTENER === "true") {
    raydiumPoolListener.setSocketIO(io); // Connect Socket.IO for real-time events
    raydiumPoolListener.startListening().catch((err) => {
      log.error(`Failed to start Raydium pool listener: ${err.message}`);
    });
    log.info("🎧 Raydium pool listener enabled with real-time events");
  }

  // Start stored token checker for periodic re-evaluation
  if (process.env.STORED_TOKEN_CHECKER_ENABLED === "true") {
    storedTokenChecker.setSocketIO(io);
    storedTokenChecker.start();
    log.info("🔍 Stored token checker enabled");
  }

  server.listen(ENV.PORT, () => {
    log.info(`⚡ Backend online → http://localhost:${ENV.PORT}`);
  });
})();
