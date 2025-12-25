import { getConnection } from "../services/solana.service.js";
import { PublicKey } from "@solana/web3.js";

// Fetch price, liquidity, and volume history for a token (stub: replace with real data source)
export async function getTokenHistory(mint: string): Promise<{
  priceHistory: number[];
  liquidityHistory: number[];
  volumeHistory: number[];
}> {
  // TODO: Replace with real historical data (from DB, API, or in-memory cache)
  // For now, return dummy arrays
  return {
    priceHistory: [],
    liquidityHistory: [],
    volumeHistory: [],
  };
}
