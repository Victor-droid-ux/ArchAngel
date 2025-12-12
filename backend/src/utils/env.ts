import dotenv from "dotenv";
dotenv.config();

const requireEnv = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

export const ENV = {
  PORT: process.env.PORT ?? "4000",
  FRONTEND_URL: process.env.FRONTEND_URL ?? "http://localhost:3000",

  // DB
  MONGO_URI: process.env.MONGO_URI ?? "",
  MONGO_DB_NAME: process.env.MONGO_DB_NAME ?? "archangel",

  // Helius + RPC
  HELIUS_RPC_URL: process.env.HELIUS_RPC_URL ?? "",
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ?? "",

  // Raydium / Quicknode endpoints or RPC-enhanced endpoints
  RAYDIUM_API_URL: process.env.RAYDIUM_API_URL ?? "",

  // Feature flags
  USE_REAL_SWAP: process.env.USE_REAL_SWAP === "true",

  // Alerts
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
  ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM ?? "",
  ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO ?? "",

  // ADMIN wallet (server-side for signing auto-sell)
  ADMIN_WALLET_SECRET: process.env.ADMIN_WALLET_SECRET ?? "",

  // Quick tuning
  TOKEN_MIN_MARKETCAP_SOL: Number(process.env.TOKEN_MIN_MARKETCAP_SOL ?? "2"), // 2 SOL default
  AUTO_TRADE_PERCENT_OF_BALANCE: Number(
    process.env.AUTO_TRADE_PERCENT_OF_BALANCE ?? "0.02"
  ), // 2%
};
