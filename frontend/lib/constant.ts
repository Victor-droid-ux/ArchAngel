// frontend/components/ui/constants.ts

/**
 * ✅ Global constants for ArchAngel Trading Bot UI
 * Centralized config for environment keys, API routes, and defaults
 */

// 🔹 Environment-based settings
export const ENV = {
  NODE_ENV: process.env.NODE_ENV || "development",
  API_BASE_URL:
    process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3000/api",
  SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001", // backend socket server
  SOLANA_RPC_URL:
    process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com",
};

// 🔹 Trading configuration defaults
export const DEFAULT_CONFIG = {
  TRADE_AMOUNT_SOL: 0.1,
  SLIPPAGE: 1.5, // %
  TAKE_PROFIT: 10, // %
  STOP_LOSS: 5, // %
  AUTO_TRADE: false,
  DEX_ROUTE: "Raydium", // Jupiter | Raydium | Orca
};

// 🔹 Common API endpoints
export const API_ROUTES = {
  STATS: `${ENV.API_BASE_URL}/stats`,
  TRADE: `${ENV.API_BASE_URL}/trade`,
  TOKENS: `${ENV.API_BASE_URL}/tokens`,
  CONFIG: `${ENV.API_BASE_URL}/config`,
};

// 🔹 App metadata
export const APP_INFO = {
  NAME: "ArchAngel Bot",
  VERSION: "1.0.0",
  AUTHOR: "ArchAngel Labs",
  DESCRIPTION:
    "AI-powered Solana trading bot for automating meme coin strategies.",
};

// 🔹 UI constants
export const UI = {
  REFRESH_INTERVAL: 10000, // ms
  SOCKET_RETRY_DELAY: 3000,
  MAX_TRADE_LOGS: 50,
};
