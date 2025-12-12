import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("solana.service");

const COMMITMENT: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) ?? "confirmed";

let _connection: Connection | null = null;

/**
 * 🧠 Singleton Solana RPC connection
 * Uses Helius RPC when SOLANA_RPC_URL is set to Helius endpoint in .env
 * This connection is used for all blockchain reads, transaction submission, and metadata queries
 */
export function getConnection(): Connection {
  if (!_connection) {
    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    _connection = new Connection(rpcUrl, COMMITMENT);
    log.info(
      `✅ RPC connected → ${
        rpcUrl.includes("helius") ? "Helius" : "Custom"
      } (commitment=${COMMITMENT})`
    );
  }
  return _connection;
}

/**
 * Optional WebSocket connection
 */
let _wsConnection: Connection | null = null;
export function getWsConnection(): Connection | null {
  const wsUrl = process.env.SOLANA_WS_URL;
  if (!_wsConnection && wsUrl) {
    _wsConnection = new Connection(wsUrl, COMMITMENT);
    log.info(`WS connected → ${wsUrl}`);
  }
  return _wsConnection;
}

/**
 * 🔐 Load backend signer from SECRET_KEY in .env
 * Supports both base58 string and JSON array format
 */
export function loadKeypairFromEnv(): Keypair {
  const raw = process.env.SECRET_KEY;
  if (!raw) throw new Error("SECRET_KEY missing");

  try {
    // Try parsing as JSON array first
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length >= 64) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch {
    // Not JSON, try as base58 string
    try {
      const bs58 = require("bs58");
      const decoded = bs58.decode(raw);
      return Keypair.fromSecretKey(decoded);
    } catch (err) {
      log.error(
        { error: (err as Error).message },
        "Failed to decode SECRET_KEY as base58"
      );
    }
  }

  throw new Error(
    "SECRET_KEY must be either a JSON array [0,1,2,...] or base58 string"
  );
}

/**
 * 🌐 Get wallet balance (in lamports)
 */
export async function getBalance(pubkey: PublicKey | string) {
  const conn = getConnection();
  const pk = new PublicKey(pubkey);
  return conn.getBalance(pk, COMMITMENT);
}

/**
 * 💰 Get wallet balance in SOL
 */
export async function getBalanceInSol(
  pubkey: PublicKey | string
): Promise<number> {
  try {
    const lamports = await getBalance(pubkey);
    const sol = lamports / 1e9; // Convert lamports to SOL

    log.debug(
      {
        wallet:
          typeof pubkey === "string"
            ? pubkey.slice(0, 8) + "..."
            : pubkey.toBase58().slice(0, 8) + "...",
        lamports,
        sol: sol.toFixed(4),
        rpcUrl: process.env.SOLANA_RPC_URL || "default",
      },
      "Fetched wallet balance"
    );

    return sol;
  } catch (err) {
    log.error(
      {
        wallet: typeof pubkey === "string" ? pubkey : pubkey.toBase58(),
        error: (err as Error).message,
      },
      "Failed to fetch wallet balance"
    );
    return 0;
  }
}

/**
 * ✅ Check if wallet has sufficient balance for trade
 * @param pubkey - Wallet public key
 * @param amountSol - Required amount in SOL
 * @param bufferPct - Safety buffer percentage (default 5% for fees)
 * @returns true if sufficient balance exists
 */
export async function hasSufficientBalance(
  pubkey: PublicKey | string,
  amountSol: number,
  bufferPct: number = 0.05
): Promise<boolean> {
  const balance = await getBalanceInSol(pubkey);
  const requiredWithBuffer = amountSol * (1 + bufferPct);

  log.info(
    {
      balance: balance.toFixed(4),
      required: amountSol.toFixed(4),
      requiredWithBuffer: requiredWithBuffer.toFixed(4),
      sufficient: balance >= requiredWithBuffer,
    },
    "Balance check"
  );

  return balance >= requiredWithBuffer;
}

/**
 * 🚀 Safe Raydium swap executor with retry & strong confirmation
 */
export async function signAndSendVersionedTx(
  tx: VersionedTransaction,
  signer = loadKeypairFromEnv(),
  maxRetries = 3
) {
  const conn = getConnection();

  tx.sign([signer]);
  const raw = tx.serialize();

  let signature: string | null = null;
  let attempt = 0;

  // retry sending transaction
  while (!signature && attempt < maxRetries) {
    try {
      signature = await conn.sendRawTransaction(raw, {
        skipPreflight: false,
      });
    } catch (err) {
      log.warn(
        { attempt, err: (err as Error).message },
        "sendRawTransaction retry"
      );
      attempt++;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  if (!signature) {
    throw new Error("Failed to send transaction after retries");
  }

  const latest = await conn.getLatestBlockhash("confirmed");

  await conn.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  log.info({ signature }, "Txn confirmed");

  return signature;
}
