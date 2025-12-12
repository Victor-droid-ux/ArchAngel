import axios from "axios";
import { Server as SocketIOServer } from "socket.io";
import { getLogger } from "../utils/logger.js";

const log = getLogger("tokenPrice.service");

export type TokenInfo = {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logo?: string;
  price?: number | null;
  marketCap?: number | null;
  liquidity?: number | null;
};

let trackedTokens: TokenInfo[] = [
  // Start with SOL & USDC — expand later automatically
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G6Q1MTQ22jQ3v", symbol: "USDC" },
];

let priceCache = new Map<string, TokenInfo>();

export function addTrackedToken(mint: string, symbol = "") {
  if (!trackedTokens.some((t) => t.mint === mint)) {
    trackedTokens.push({ mint, symbol });
    log.info(
      { mint: mint.slice(0, 8), symbol, total: trackedTokens.length },
      "✅ Token added to tracked list"
    );

    // Add to cache immediately so it shows up right away
    priceCache.set(mint, {
      mint,
      symbol: symbol || "NEW",
      name: "New Token",
      decimals: 9,
      price: null,
      marketCap: null,
      liquidity: null,
    });
  } else {
    log.debug({ mint: mint.slice(0, 8) }, "Token already tracked");
  }
}

export function getLatestTokens(): TokenInfo[] {
  const tokens = Array.from(priceCache.values());
  log.debug({ count: tokens.length }, "Returning tracked tokens");
  return tokens;
}

async function fetchTokenDataBatch(mints: string[]) {
  // Use Birdeye Price API for token price data
  try {
    const mintsParam = mints.join(",");
    const url = `https://public-api.birdeye.so/defi/multi_price?list_address=${mintsParam}`;
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        "X-API-KEY": process.env.BIRDEYE_API_KEY || "",
      },
    });

    const results: TokenInfo[] = [];
    for (const mint of mints) {
      const priceData = data.data?.[mint];
      if (priceData) {
        results.push({
          mint,
          symbol: trackedTokens.find((t) => t.mint === mint)?.symbol ?? "???",
          name: "Token",
          decimals: 9,
          price: priceData.value ?? null,
          marketCap: priceData.liquidity ?? null, // Birdeye uses liquidity field
          liquidity: priceData.liquidity ?? null,
        });
      }
    }
    return results;
  } catch (err) {
    log.warn({ err: String(err) }, "Failed to fetch token prices from Birdeye");
    return [];
  }
}

async function refresh(io?: SocketIOServer) {
  try {
    const chunkSize = 30;
    const mints = trackedTokens.map((t) => t.mint);
    const newMap = new Map<string, TokenInfo>();

    for (let i = 0; i < mints.length; i += chunkSize) {
      const chunk = mints.slice(i, i + chunkSize);
      const results = await fetchTokenDataBatch(chunk);
      results.forEach((t: TokenInfo) => newMap.set(t.mint, t));
    }

    priceCache = newMap;

    if (io) {
      io.emit("token_prices", { tokens: getLatestTokens() });
      log.info(`📡 Broadcasted ${priceCache.size} token prices`);
    }
  } catch (err: any) {
    log.error({ err: err?.message || String(err) }, "Price refresh error");
  }
}

export function startTokenPriceService(io: SocketIOServer) {
  refresh(io).catch(console.error);
  setInterval(() => refresh(io).catch(console.error), 10_000);
}
