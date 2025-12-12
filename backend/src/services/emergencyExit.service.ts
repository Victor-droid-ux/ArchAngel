// backend/src/services/emergencyExit.service.ts
import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import { getRaydiumQuote } from "./raydium.service.js";

const LOG = getLogger("emergency-exit");

// Use Helius RPC for monitoring
const SOLANA_RPC =
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL) ||
  process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
  "https://api.mainnet-beta.solana.com";

const commitment: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) || "confirmed";

const connection = new Connection(SOLANA_RPC, commitment);

interface EmergencyTrigger {
  triggered: boolean;
  reason?: string;
  severity: "critical" | "high" | "medium";
}

/**
 * Check if liquidity pool has been removed or rugged
 * This is the most critical emergency exit trigger
 */
export async function checkLPRemoval(
  tokenMint: string,
  poolAddress?: string
): Promise<EmergencyTrigger> {
  try {
    if (!poolAddress) {
      // If we don't have pool address, try to detect from token account
      LOG.warn({ tokenMint }, "No pool address provided for LP removal check");
      return { triggered: false, severity: "medium" };
    }

    // Check if pool account still exists
    const poolPubkey = new PublicKey(poolAddress);
    const accountInfo = await connection.getAccountInfo(poolPubkey);

    if (!accountInfo) {
      LOG.error(
        { tokenMint, poolAddress },
        "EMERGENCY: Liquidity pool account not found - LP REMOVED!"
      );
      return {
        triggered: true,
        reason: "Liquidity pool removed (rug pull detected)",
        severity: "critical",
      };
    }

    // Check if pool is closed (lamports = 0)
    if (accountInfo.lamports === 0) {
      LOG.error(
        { tokenMint, poolAddress },
        "EMERGENCY: Liquidity pool closed - LP REMOVED!"
      );
      return {
        triggered: true,
        reason: "Liquidity pool closed (zero lamports)",
        severity: "critical",
      };
    }

    return { triggered: false, severity: "medium" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error checking LP removal"
    );
    return { triggered: false, severity: "medium" };
  }
}

/**
 * Detect massive sell (single transaction >= 50% of LP)
 * Uses recent transaction monitoring
 */
export async function detectLargeSell(
  tokenMint: string,
  poolAddress?: string
): Promise<EmergencyTrigger> {
  try {
    if (!poolAddress) {
      return { triggered: false, severity: "high" };
    }

    const tokenPubkey = new PublicKey(tokenMint);

    // Get recent signatures (last 10 transactions)
    const signatures = await connection.getSignaturesForAddress(tokenPubkey, {
      limit: 10,
    });

    if (signatures.length === 0) {
      return { triggered: false, severity: "high" };
    }

    // Check most recent transaction for large sell
    // In production, you'd parse the transaction to get actual sell size
    // For now, we'll use a heuristic based on transaction size
    const latestSig = signatures[0];
    if (!latestSig) {
      return { triggered: false, severity: "high" };
    }

    const txDetails = await connection.getTransaction(latestSig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!txDetails) {
      return { triggered: false, severity: "high" };
    }

    // Check for large value transfers (simplified check)
    // In production, parse swap instructions to get exact sell amount
    const preBalances = txDetails.meta?.preBalances || [];
    const postBalances = txDetails.meta?.postBalances || [];

    for (let i = 0; i < preBalances.length; i++) {
      const preBalance = preBalances[i];
      const postBalance = postBalances[i];
      if (preBalance === undefined || postBalance === undefined) continue;

      const balanceChange = Math.abs(postBalance - preBalance);
      const solChange = balanceChange / 1e9;

      // If any account had a balance change > 10 SOL, consider it suspicious
      if (solChange > 10) {
        LOG.warn(
          {
            tokenMint,
            solChange,
            signature: latestSig.signature,
          },
          "Large transaction detected - potential massive sell"
        );
        return {
          triggered: true,
          reason: `Large sell detected (${solChange.toFixed(2)} SOL)`,
          severity: "high",
        };
      }
    }

    return { triggered: false, severity: "high" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error detecting large sell"
    );
    return { triggered: false, severity: "high" };
  }
}

interface PricePoint {
  price: number;
  timestamp: number;
}

const priceHistory = new Map<string, PricePoint[]>();

/**
 * Detect 60% red candle in 10 seconds
 * Monitors rapid price crash
 */
export async function detectRedCandle(
  tokenMint: string,
  currentPrice: number
): Promise<EmergencyTrigger> {
  try {
    const now = Date.now();
    const history = priceHistory.get(tokenMint) || [];

    // Add current price point
    history.push({ price: currentPrice, timestamp: now });

    // Keep only last 30 seconds of history
    const recentHistory = history.filter((p) => now - p.timestamp <= 30000);
    priceHistory.set(tokenMint, recentHistory);

    // Check for 60% drop in last 10 seconds
    const tenSecondsAgo = now - 10000;
    const recentPrices = recentHistory.filter(
      (p) => p.timestamp >= tenSecondsAgo
    );

    if (recentPrices.length < 2) {
      return { triggered: false, severity: "high" };
    }

    const highestRecent = Math.max(...recentPrices.map((p) => p.price));
    const lowestRecent = Math.min(...recentPrices.map((p) => p.price));

    const dropPct = (highestRecent - lowestRecent) / highestRecent;

    if (dropPct >= 0.6) {
      LOG.error(
        {
          tokenMint,
          highestRecent,
          lowestRecent,
          dropPct: (dropPct * 100).toFixed(1),
        },
        "EMERGENCY: 60% red candle detected!"
      );
      return {
        triggered: true,
        reason: `60% price crash in 10 seconds (${(dropPct * 100).toFixed(
          1
        )}% drop)`,
        severity: "critical",
      };
    }

    return { triggered: false, severity: "high" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error detecting red candle"
    );
    return { triggered: false, severity: "high" };
  }
}

/**
 * Detect creator wallet selling
 * Requires tracking creator wallet address
 */
export async function detectCreatorSell(
  tokenMint: string,
  creatorAddress?: string
): Promise<EmergencyTrigger> {
  try {
    if (!creatorAddress) {
      LOG.debug(
        { tokenMint },
        "No creator address provided for creator sell check"
      );
      return { triggered: false, severity: "high" };
    }

    const creatorPubkey = new PublicKey(creatorAddress);

    // Get recent transactions for creator wallet
    const signatures = await connection.getSignaturesForAddress(creatorPubkey, {
      limit: 5,
    });

    if (signatures.length === 0) {
      return { triggered: false, severity: "high" };
    }

    // Check if any recent transaction involves selling this token
    // In production, you'd parse the transaction to check for token sells
    const latestSig = signatures[0];
    if (!latestSig) {
      return { triggered: false, severity: "high" };
    }

    // If transaction was very recent (< 30 seconds), consider it suspicious
    const txTime = latestSig.blockTime || 0;
    const now = Math.floor(Date.now() / 1000);

    if (now - txTime < 30) {
      LOG.warn(
        {
          tokenMint,
          creatorAddress,
          signature: latestSig.signature,
        },
        "Recent creator transaction detected - potential creator sell"
      );
      return {
        triggered: true,
        reason: "Creator wallet activity detected",
        severity: "high",
      };
    }

    return { triggered: false, severity: "high" };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error detecting creator sell"
    );
    return { triggered: false, severity: "high" };
  }
}

/**
 * Run all emergency exit checks
 * Returns true if ANY critical trigger is detected
 */
export async function checkAllEmergencyTriggers(
  tokenMint: string,
  currentPrice: number,
  poolAddress?: string,
  creatorAddress?: string
): Promise<{
  shouldExit: boolean;
  triggers: EmergencyTrigger[];
  criticalReason?: string;
}> {
  try {
    const triggers = await Promise.all([
      checkLPRemoval(tokenMint, poolAddress),
      detectLargeSell(tokenMint, poolAddress),
      detectRedCandle(tokenMint, currentPrice),
      detectCreatorSell(tokenMint, creatorAddress),
    ]);

    // Check for any critical triggers
    const criticalTrigger = triggers.find(
      (t) => t.triggered && t.severity === "critical"
    );

    if (criticalTrigger) {
      return {
        shouldExit: true,
        triggers,
        criticalReason: criticalTrigger.reason || "Critical exit trigger",
      };
    }

    // Check for multiple high-severity triggers
    const highTriggers = triggers.filter(
      (t) => t.triggered && t.severity === "high"
    );

    if (highTriggers.length >= 2) {
      return {
        shouldExit: true,
        triggers,
        criticalReason: `Multiple warning signs: ${highTriggers
          .map((t) => t.reason)
          .join(", ")}`,
      };
    }

    return {
      shouldExit: false,
      triggers,
    };
  } catch (err: any) {
    LOG.error(
      { err: err.message || err, tokenMint },
      "Error checking emergency triggers"
    );
    return {
      shouldExit: false,
      triggers: [],
    };
  }
}
