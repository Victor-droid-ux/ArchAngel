// backend/src/services/raydium/config.ts
import dotenv from "dotenv";
import https from "https";
dotenv.config();

// Determine RPC URL priority: QuickNode > Helius > Solana public
const RPC_URL =
  process.env.QUICKNODE_URL ||
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");

const WALLET_SECRET_KEY = (
  process.env.WALLET_PRIVATE_KEY ||
  process.env.WALLET_SECRET_KEY ||
  ""
).trim();

if (!RPC_URL) {
  throw new Error(
    "RPC_URL is not configured. Set QUICKNODE_URL, HELIUS_API_KEY, or SOLANA_RPC_URL"
  );
}

if (!WALLET_SECRET_KEY) {
  throw new Error(
    "WALLET_SECRET_KEY or WALLET_PRIVATE_KEY is not set in environment variables"
  );
}

// Validate that the key looks like a base58 string
if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(WALLET_SECRET_KEY)) {
  throw new Error(
    "WALLET_SECRET_KEY contains invalid characters. It should be a base58-encoded string. Check your .env file for extra spaces or invalid characters."
  );
}

interface PriorityFeeResponse {
  jsonrpc: string;
  result: {
    per_compute_unit: {
      extreme: number;
      medium: number;
    };
  };
  id: number;
}

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  data: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString()));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function fetchPriorityFee(): Promise<number> {
  // Only fetch from QuickNode if available
  if (!process.env.QUICKNODE_URL) {
    // Fallback to static fee if QuickNode not configured
    return 0.0001; // 0.0001 SOL
  }

  try {
    const url = new URL(process.env.QUICKNODE_URL);
    const options: https.RequestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    };

    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "qn_estimatePriorityFees",
      params: {
        last_n_blocks: 100,
        account: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium V4 program
        api_version: 2,
      },
    });

    const response = await httpsRequest(url.href, options, requestBody);
    const data: unknown = JSON.parse(response);

    if (!isPriorityFeeResponse(data)) {
      throw new Error("Unexpected response format from priority fee API");
    }

    // Using the 'extreme' priority fee from 'per_compute_unit'
    const extremePriorityFeePerCU = data.result.per_compute_unit.extreme;

    // Estimate compute units for the transaction
    const estimatedComputeUnits = 300000;

    // Calculate total priority fee in micro-lamports
    const totalPriorityFeeInMicroLamports =
      extremePriorityFeePerCU * estimatedComputeUnits;

    // Convert to SOL (1 SOL = 1e9 lamports = 1e15 micro-lamports)
    const priorityFeeInSOL = totalPriorityFeeInMicroLamports / 1e15;

    // Ensure the fee is not less than 0.000001 SOL (minimum fee)
    return Math.max(priorityFeeInSOL, 0.000001);
  } catch (error) {
    console.error("Failed to fetch priority fee, using fallback:", error);
    return 0.0001; // Fallback fee
  }
}

function isPriorityFeeResponse(data: unknown): data is PriorityFeeResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "jsonrpc" in data &&
    "result" in data &&
    typeof data.result === "object" &&
    data.result !== null &&
    "per_compute_unit" in data.result &&
    typeof data.result.per_compute_unit === "object" &&
    data.result.per_compute_unit !== null &&
    "extreme" in data.result.per_compute_unit &&
    typeof data.result.per_compute_unit.extreme === "number"
  );
}

export const CONFIG = {
  RPC_URL,
  WALLET_SECRET_KEY,
  BASE_MINT: "So11111111111111111111111111111111111111112", // SOL mint address
  QUOTE_MINT: "EPjFWdd5AufqSSqeM2qU7yP5eyh8DkY3QJrGVRmZAFh", // USDC mint address
  TOKEN_A_AMOUNT: 0.000001,
  EXECUTE_SWAP: process.env.USE_REAL_SWAP === "true",
  USE_VERSIONED_TRANSACTION: true,
  SLIPPAGE: Number(process.env.DEFAULT_SLIPPAGE) || 5,
  getPriorityFee: fetchPriorityFee,
};
