import axios from "axios";
import { ENV } from "../utils/env.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("helius");

export async function heliusRpc(method: string, params: any) {
  const url = ENV.HELIUS_RPC_URL;
  if (!url) throw new Error("HELIUS_RPC_URL missing");
  try {
    const { data } = await axios.post(url, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    return data.result ?? data;
  } catch (err: any) {
    log.error("Helius RPC error: " + String(err?.message ?? err));
    throw err;
  }
}

/**
 * Example quick helper to get token metadata / supply if Helius supports it
 * (You may replace with the Helius REST endpoint or other method)
 */
export async function getTokenMintInfo(mint: string) {
  return heliusRpc("getTokenMintInfo", [mint]);
}
