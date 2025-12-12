import { PublicKey, Connection } from "@solana/web3.js";
import {
  LiquidityPoolKeys,
  LiquidityPoolInfo,
  Liquidity,
} from "@raydium-io/raydium-sdk";

import fs from "fs";
import path from "path";
import { getLogger } from "../../utils/logger.js";

const log = getLogger("raydium-pools");

// RPC Connection for fetching pool info
const RPC_URL =
  process.env.QUICKNODE_URL ||
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");

const connection = new Connection(RPC_URL, "confirmed");

// Cached pools
let POOLS: LiquidityPoolKeys[] = [];
let LOADED = false;

/* ----------------------------------------------------
   Load Raydium Pools from mainnet.json
   (placed inside /services/raydium/mainnet.json)
---------------------------------------------------- */
export function loadRaydiumPools() {
  if (LOADED) return POOLS;

  try {
    const filePath = path.join(
      process.cwd(),
      "src",
      "services",
      "raydium",
      "mainnet.json"
    );

    if (!fs.existsSync(filePath)) {
      throw new Error("❌ Raydium mainnet.json file is missing.");
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed?.official?.liquidityPools) {
      throw new Error("❌ Invalid mainnet.json Raydium format.");
    }

    POOLS = parsed.official.liquidityPools as LiquidityPoolKeys[];
    LOADED = true;

    log.info(`📦 Loaded ${POOLS.length} Raydium pools from mainnet.json`);
  } catch (err: any) {
    log.error("❌ Failed to load Raydium pools: " + err.message);
  }

  return POOLS;
}

/* ----------------------------------------------------
   Get Pool For Token Mint
---------------------------------------------------- */
export async function getPoolForToken(tokenMint: PublicKey): Promise<{
  poolKeys: LiquidityPoolKeys;
  poolInfo: LiquidityPoolInfo;
} | null> {
  // Ensure pools are loaded
  const pools = loadRaydiumPools();
  if (!pools || pools.length === 0) return null;

  // Try to match either baseMint OR quoteMint
  const mintString = tokenMint.toBase58();

  const found = pools.find(
    (p) =>
      p.baseMint.toString() === mintString ||
      p.quoteMint.toString() === mintString
  );

  if (!found) {
    log.warn(`⚠️ No pool found for token ${mintString}`);
    return null;
  }

  // Fetch pool state on-chain
  try {
    const info = await Liquidity.fetchInfo({ connection, poolKeys: found });
    return {
      poolKeys: found,
      poolInfo: info,
    };
  } catch (err: any) {
    log.error("❌ Failed fetching pool info: " + err.message);
    return null;
  }
}
