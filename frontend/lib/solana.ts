import {
  Connection,
  clusterApiUrl,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  getAccount,
  getAssociatedTokenAddress,
  getMint,
  transfer,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/* -------------------------------------------------------------------------- */
/* 🛰️  SOLANA CONNECTION SETUP */
/* -------------------------------------------------------------------------- */

const SOLANA_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "mainnet-beta";

const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  clusterApiUrl(SOLANA_CLUSTER as any);

export const connection = new Connection(RPC_ENDPOINT, "confirmed");

/* -------------------------------------------------------------------------- */
/* 💰  WALLET HELPERS */
/* -------------------------------------------------------------------------- */

export async function getSolBalance(address: string): Promise<number> {
  try {
    const publicKey = new PublicKey(address);
    const lamports = await connection.getBalance(publicKey);
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    console.error("Error fetching SOL balance:", err);
    return 0;
  }
}

export async function toSOL(lamports: number): Promise<number> {
  return lamports / LAMPORTS_PER_SOL;
}

export function toLamports(sol: number): number {
  return sol * LAMPORTS_PER_SOL;
}

/* -------------------------------------------------------------------------- */
/* 🪙  SPL TOKEN HELPERS */
/* -------------------------------------------------------------------------- */

export async function getTokenAccount(
  walletAddress: string,
  mintAddress: string
): Promise<PublicKey> {
  return await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    new PublicKey(walletAddress)
  );
}

export async function getTokenBalance(
  walletAddress: string,
  mintAddress: string
): Promise<number> {
  try {
    const tokenAccount = await getTokenAccount(walletAddress, mintAddress);
    const accountInfo = await getAccount(connection, tokenAccount);
    const mintInfo = await getMint(connection, new PublicKey(mintAddress));

    return Number(accountInfo.amount) / Math.pow(10, mintInfo.decimals);
  } catch (err) {
    console.error("Error fetching token balance:", err);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* 🧮  TOKEN PRICE FETCHING (DEXSCREENER + RAYDIUM API) */
/* -------------------------------------------------------------------------- */

/**
 * Fetch token price from Dexscreener
 */
export async function getTokenPrice(symbolOrAddress: string): Promise<number> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${symbolOrAddress}`
    );
    const data = await res.json();

    if (data.pairs && data.pairs.length > 0) {
      return parseFloat(data.pairs[0].priceUsd);
    }

    throw new Error("Price not found");
  } catch (err) {
    console.warn(`⚠️ Dexscreener fallback for ${symbolOrAddress}:`, err);
    // fallback to Raydium quote via backend
    return await getRaydiumPrice(symbolOrAddress);
  }
}

/**
 * Fetch token price from Raydium via backend
 */
export async function getRaydiumPrice(
  symbolOrAddress: string
): Promise<number> {
  try {
    // Use backend API to get Raydium price
    const res = await fetch(
      `${
        process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000"
      }/api/tokens?mint=${symbolOrAddress}`
    );
    const data = await res.json();
    const token = data?.data?.find((t: any) => t.mint === symbolOrAddress);
    return token?.priceSol ? parseFloat(token.priceSol) : 0;
  } catch (err) {
    console.error("Error fetching Raydium price:", err);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* 🔁  RAYDIUM DEX SWAP EXECUTION */
/* -------------------------------------------------------------------------- */

/**
 * Build and execute swap transaction via Raydium (through backend)
 */
export async function executeRaydiumSwap({
  inputMint,
  outputMint,
  amount,
  slippageBps,
  wallet,
}: {
  inputMint: string; // e.g. SOL
  outputMint: string; // Token mint address
  amount: number; // in smallest unit (lamports or token units)
  slippageBps?: number; // 50 = 0.5%
  wallet: string; // wallet address
}) {
  try {
    // Use backend to prepare Raydium swap
    const BACKEND_URL =
      process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
    const response = await fetch(`${BACKEND_URL}/api/trade/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type:
          inputMint === "So11111111111111111111111111111111111111112"
            ? "buy"
            : "sell",
        inputMint,
        outputMint,
        wallet,
        amountLamports: amount,
        slippageBps: slippageBps || 50,
      }),
    });

    const data = await response.json();

    if (!data.success || !data.data?.transaction) {
      throw new Error(data.message || "No swap transaction returned");
    }

    console.log("💹 Raydium swap quote received");
    return data.data;
  } catch (err) {
    console.error("❌ Raydium swap failed:", err);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* ⚙️  UTILITIES */
/* -------------------------------------------------------------------------- */

export async function sendTransaction(
  tx: Transaction,
  signers: any[]
): Promise<string | null> {
  try {
    const signature = await sendAndConfirmTransaction(connection, tx, signers);
    console.log("✅ Transaction confirmed:", signature);
    return signature;
  } catch (err) {
    console.error("❌ Transaction failed:", err);
    return null;
  }
}
