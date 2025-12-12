// backend/src/services/priceStreamer.service.ts
import { Server } from "socket.io";
import { getLogger } from "../utils/logger.js";
import { fetchPricesForMints } from "./raydium.service.js";

const log = getLogger("priceStreamer");

/**
 * Stream prices over WebSocket
 * @param io socket server
 * @param tokens array of tokens: { mint, symbol }
 */
export function startPriceStreamer(
  io: Server,
  tokens: { mint: string; symbol: string }[] = []
) {
  async function tick() {
    try {
      if (tokens.length === 0) return;

      const mints = tokens.map((t) => t.mint);
      const pricesMap = await fetchPricesForMints(mints);

      tokens.forEach((t) => {
        const price = Number(pricesMap[t.mint]?.price ?? 0);

        if (!price) {
          log.warn({ mint: t.mint, symbol: t.symbol }, "No price found");
          return;
        }

        io.emit("priceUpdate", {
          symbol: t.symbol,
          mint: t.mint,
          price,
          timestamp: new Date().toISOString(),
        });
      });
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "priceStreamer tick failed"
      );
    }
  }

  log.info("📡 Live price streamer initialized");
  tick();
  setInterval(tick, 5000);
}
