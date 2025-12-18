// backend/src/services/db.service.ts

import { MongoClient, Db, Collection } from "mongodb";
import { getLogger } from "../utils/logger.js";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "archangel";

const log = getLogger("db.service");

/* ---------------------------------------
   TYPE DEFINITIONS
---------------------------------------- */
export type TradeRecord = {
  id: string;
  type: "buy" | "sell";
  token: string;
  inputMint?: string;
  outputMint?: string;
  amountLamports: number;
  amountSol: number;
  price?: number;
  pnl?: number; // percent decimal ex: 0.02 means +2%
  pnlSol?: number; // absolute SOL PnL
  wallet?: string;
  simulated?: boolean;
  signature?: string | null;
  timestamp: Date;
  route?: "pump.fun" | "raydium";
};

export type StatsDoc = {
  _id?: string;
  portfolioValue: number;
  totalProfitSol: number;
  totalProfitPercent: number;
  openTrades: number;
  tradeVolumeSol: number;
  winRate: number;
  lastUpdated: Date;
};

export type PortfolioPnL = {
  totalInvestedSol: number;
  totalReturnedSol: number;
  unrealizedPnlSol: number;
  realizedPnlSol: number;
  totalPnlSol: number;
  totalPnlPercent: number;
  winningTrades: number;
  losingTrades: number;
  totalTrades: number;
  winRate: number;
  averageWinSol: number;
  averageLossSol: number;
  largestWinSol: number;
  largestLossSol: number;
  openPositionsValue: number;
  closedPositionsValue: number;
  roi: number; // Return on Investment %
};

export type TokenPnL = {
  token: string;
  symbol?: string;
  totalBought: number; // SOL spent
  totalSold: number; // SOL received
  remainingTokens: number;
  averageBuyPrice: number;
  currentValue?: number;
  pnlSol: number;
  pnlPercent: number;
  trades: number;
  status: "open" | "closed";
};

export type UserSettings = {
  wallet: string;
  autoMode: boolean;
  manualAmountSol?: number | null;
  updatedAt: Date;
};

export type WatchlistToken = {
  _id?: string;
  mint: string;
  symbol?: string;
  name?: string;
  addedAt: Date;
  userId?: string; // For multi-user support
  priceAlert?: {
    targetPrice: number; // Alert when price reaches this
    condition: "above" | "below";
    triggered?: boolean;
  };
  notes?: string;
};

// Token lifecycle states for new trade rules
export type TokenLifecycleState =
  | "DETECTED_ON_PUMP"
  | "AWAITING_GRADUATION"
  | "RAYDIUM_POOL_CREATED"
  | "SECURITY_VERIFIED"
  | "BOUGHT"
  | "PARTIALLY_SOLD"
  | "FULLY_EXITED"
  | "BLACKLISTED";

export type TokenState = {
  _id?: string;
  mint: string;
  symbol?: string;
  name?: string;
  state: TokenLifecycleState;
  source: "pump.fun" | "raydium" | "other";

  // Pump.fun metrics
  bondingProgress?: number;
  marketCapUSD?: number;
  buyVolume?: number;
  sellVolume?: number;

  // Raydium metrics
  raydiumPoolExists?: boolean;
  liquidityUSD?: number;
  liquiditySOL?: number;
  poolAddress?: string;

  // Security checks
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  creatorHoldings?: number;
  top3WalletsCombined?: number;
  lpRemoved?: boolean;

  // Timestamps
  detectedAt: Date;
  graduatedAt?: Date;
  boughtAt?: Date;
  exitedAt?: Date;
  blacklistedAt?: Date;

  // Blacklist reason
  blacklistReason?: string;

  updatedAt: Date;
};

/* ---------------------------------------
   CONNECTION
---------------------------------------- */
export type PositionMetadata = {
  token: string;
  highestPnlPct?: number;
  trailingActivated?: boolean;
  soldAt40?: boolean;
  soldAt80?: boolean;
  soldAt150?: boolean;
  remainingPct?: number;
  firstTrancheEntry?: number;
  secondTrancheEntry?: number;
  updatedAt: Date;
};

let client: MongoClient | null = null;
let db: Db | null = null;
let tradesCol: Collection<TradeRecord> | null = null;
let statsCol: Collection<StatsDoc> | null = null;
let watchlistCol: Collection<WatchlistToken> | null = null;
let positionMetadataCol: Collection<PositionMetadata> | null = null;
let tokenStateCol: Collection<TokenState> | null = null;

export async function connect() {
  if (client && db) return db;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB_NAME);
  tradesCol = db.collection<TradeRecord>("trades");
  statsCol = db.collection<StatsDoc>("stats");
  watchlistCol = db.collection<WatchlistToken>("watchlist");
  positionMetadataCol = db.collection<PositionMetadata>("positionMetadata");
  tokenStateCol = db.collection<TokenState>("tokenStates");
  await tradesCol.createIndex({ timestamp: -1 });
  await watchlistCol.createIndex({ mint: 1 });
  await watchlistCol.createIndex({ userId: 1 });
  await positionMetadataCol.createIndex({ token: 1 }, { unique: true });
  await tokenStateCol.createIndex({ mint: 1 }, { unique: true });
  await tokenStateCol.createIndex({ state: 1 });
  await tokenStateCol.createIndex({ updatedAt: -1 });
  // ensure stats doc exists
  const existing = await statsCol.findOne({});
  if (!existing) {
    await statsCol.insertOne({
      portfolioValue: 0,
      totalProfitSol: 0,
      totalProfitPercent: 0,
      openTrades: 0,
      tradeVolumeSol: 0,
      winRate: 0,
      lastUpdated: new Date(),
    });
  }
  log.info("Connected to MongoDB");
  return db;
}

export async function addTrade(
  tr: Omit<
    Partial<TradeRecord>,
    "amountSol" | "amountLamports" | "timestamp"
  > & { amount: number; timestamp?: Date | string }
) {
  if (!db) await connect();
  const timestamp = tr.timestamp ? new Date(tr.timestamp as any) : new Date();
  const lamports = Number(tr.amount || 0);
  const amountSol = lamports / 1e9;

  // normalize pnl passed in various formats
  let pnlPercent =
    typeof tr.pnl === "number"
      ? Math.abs(tr.pnl) <= 1
        ? tr.pnl
        : tr.pnl / 100
      : 0;
  const pnlSol = amountSol * pnlPercent;

  const record: TradeRecord = {
    id: (tr.id as string) || crypto.randomUUID(),
    type: (tr.type as "buy" | "sell") || "buy",
    token: (tr.token as string) || "UNKNOWN",
    amountLamports: lamports,
    amountSol,
    signature: tr.signature ?? null,
    timestamp,
    ...(tr.inputMint !== undefined && { inputMint: tr.inputMint }),
    ...(tr.outputMint !== undefined && { outputMint: tr.outputMint }),
    ...(tr.price !== undefined && { price: tr.price }),
    ...(pnlPercent !== 0 && { pnl: pnlPercent }),
    ...(pnlSol !== 0 && { pnlSol }),
    ...(tr.wallet !== undefined && { wallet: tr.wallet }),
    ...(tr.simulated !== undefined && { simulated: tr.simulated }),
  };

  await tradesCol!.insertOne(record);

  // atomic stats update
  const deltaOpen = record.type === "buy" ? 1 : record.type === "sell" ? -1 : 0;

  const updated = await statsCol!.findOneAndUpdate(
    {},
    {
      $inc: {
        tradeVolumeSol: amountSol,
        totalProfitSol: pnlSol,
        openTrades: deltaOpen,
      },
      $set: { lastUpdated: new Date() },
    },
    { returnDocument: "after" }
  );

  // recompute winRate & percent
  const recent = await tradesCol!
    .find({ pnl: { $exists: true } })
    .sort({ timestamp: -1 })
    .limit(500)
    .toArray();
  const wins = recent.filter((r) => (r.pnl ?? 0) > 0).length;
  const winRate = recent.length ? (wins / recent.length) * 100 : 0;
  const statsDoc = updated!;
  const totalProfitPercent = statsDoc.tradeVolumeSol
    ? statsDoc.totalProfitSol / statsDoc.tradeVolumeSol
    : 0;

  await statsCol!.updateOne(
    {},
    {
      $set: {
        winRate,
        totalProfitPercent,
        portfolioValue: (statsDoc.portfolioValue || 0) + pnlSol,
      },
    }
  );

  return record;
}

export async function getTrades(limit = 50) {
  if (!db) await connect();
  return tradesCol!.find({}).sort({ timestamp: -1 }).limit(limit).toArray();
}

export async function getStats() {
  if (!db) await connect();
  const doc = await statsCol!.findOne({});
  if (!doc) throw new Error("Stats missing");
  return doc;
}

export type Position = {
  token: string;
  netSol: number;
  avgBuyPrice?: number;
  highestPnlPct?: number;
  trailingActivated?: boolean;
  soldAt40?: boolean; // Track if 30% sold at +40% profit
  soldAt80?: boolean; // Track if 30% sold at +80% profit
  soldAt150?: boolean; // Track if 30% sold at +150% profit
  remainingPct?: number; // Track remaining position percentage (starts at 100)
  firstTrancheEntry?: number; // Timestamp of first 60% buy
  secondTrancheEntry?: number; // Timestamp of second 40% buy
};

export async function getPositions(): Promise<Position[]> {
  if (!db) await connect();
  const agg = await tradesCol!
    .aggregate([
      {
        $group: {
          _id: "$token",
          bought: {
            $sum: { $cond: [{ $eq: ["$type", "buy"] }, "$amountLamports", 0] },
          },
          sold: {
            $sum: { $cond: [{ $eq: ["$type", "sell"] }, "$amountLamports", 0] },
          },
          avgBuyPrice: {
            $avg: { $cond: [{ $eq: ["$type", "buy"] }, "$price", null] },
          },
        },
      },
      {
        $project: {
          token: "$_id",
          netSol: { $divide: [{ $subtract: ["$bought", "$sold"] }, 1e9] },
          avgBuyPrice: 1,
          _id: 0,
        },
      },
    ])
    .toArray();

  // Merge with position metadata
  const positions = agg as Position[];
  for (const pos of positions) {
    const metadata = await positionMetadataCol!.findOne({ token: pos.token });
    if (metadata) {
      if (metadata.highestPnlPct !== undefined) {
        pos.highestPnlPct = metadata.highestPnlPct;
      }
      if (metadata.trailingActivated !== undefined) {
        pos.trailingActivated = metadata.trailingActivated;
      }
    }
  }

  return positions;
}

export async function updatePositionMetadata(
  token: string,
  updates: Partial<Omit<PositionMetadata, "token" | "updatedAt">>
): Promise<void> {
  if (!db) await connect();
  await positionMetadataCol!.updateOne(
    { token },
    {
      $set: {
        ...updates,
        updatedAt: new Date(),
      },
      $setOnInsert: { token },
    },
    { upsert: true }
  );
}

export async function updateStats(updates: Partial<StatsDoc>) {
  if (!db) await connect();
  const out = await statsCol!.findOneAndUpdate(
    {},
    { $set: { ...updates, lastUpdated: new Date() } },
    { returnDocument: "after" }
  );
  return out!;
}

/* ---------------------------------------
   WATCHLIST FUNCTIONS
---------------------------------------- */
export async function addToWatchlist(
  token: Omit<WatchlistToken, "_id" | "addedAt">
) {
  if (!db) await connect();

  // Check if already exists
  const filter: any = { mint: token.mint };
  if (token.userId) filter.userId = token.userId;

  const existing = await watchlistCol!.findOne(filter);
  if (existing) {
    return { success: false, error: "Token already in watchlist", existing };
  }

  const doc: WatchlistToken = {
    ...token,
    addedAt: new Date(),
  };

  const result = await watchlistCol!.insertOne(doc as any);
  return { success: true, id: result.insertedId, doc };
}

export async function getWatchlist(userId?: string) {
  if (!db) await connect();
  const filter = userId ? { userId } : {};
  return watchlistCol!.find(filter).sort({ addedAt: -1 }).toArray();
}

export async function removeFromWatchlist(mint: string, userId?: string) {
  if (!db) await connect();
  const filter: any = { mint };
  if (userId) filter.userId = userId;

  const result = await watchlistCol!.deleteOne(filter);
  return {
    success: result.deletedCount > 0,
    deletedCount: result.deletedCount,
  };
}

export async function updateWatchlistAlert(
  mint: string,
  priceAlert: WatchlistToken["priceAlert"],
  userId?: string
) {
  if (!db) await connect();
  const filter: any = { mint };
  if (userId) filter.userId = userId;

  const update: any = { $set: { priceAlert } };
  const result = await watchlistCol!.updateOne(filter, update);
  return {
    success: result.modifiedCount > 0,
    modifiedCount: result.modifiedCount,
  };
}

/* ---------------------------------------
   PORTFOLIO P&L TRACKING
---------------------------------------- */

/**
 * Calculate comprehensive portfolio P&L
 */
export async function getPortfolioPnL(): Promise<PortfolioPnL> {
  if (!db) await connect();

  const trades = await tradesCol!.find({}).sort({ timestamp: 1 }).toArray();

  let totalInvestedSol = 0;
  let totalReturnedSol = 0;
  let realizedPnlSol = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalWinSol = 0;
  let totalLossSol = 0;
  let largestWinSol = 0;
  let largestLossSol = 0;

  for (const trade of trades) {
    if (trade.type === "buy") {
      totalInvestedSol += trade.amountSol;
    } else if (trade.type === "sell") {
      totalReturnedSol += trade.amountSol;

      if (trade.pnlSol) {
        realizedPnlSol += trade.pnlSol;

        if (trade.pnlSol > 0) {
          winningTrades++;
          totalWinSol += trade.pnlSol;
          largestWinSol = Math.max(largestWinSol, trade.pnlSol);
        } else if (trade.pnlSol < 0) {
          losingTrades++;
          totalLossSol += Math.abs(trade.pnlSol);
          largestLossSol = Math.max(largestLossSol, Math.abs(trade.pnlSol));
        }
      }
    }
  }

  // Get current open positions value
  const positions = await getPositions();
  let unrealizedPnlSol = 0;
  let openPositionsValue = 0;

  for (const pos of positions) {
    openPositionsValue += pos.netSol;
    // Unrealized P&L would require current prices - placeholder for now
  }

  const totalTrades = winningTrades + losingTrades;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const averageWinSol = winningTrades > 0 ? totalWinSol / winningTrades : 0;
  const averageLossSol = losingTrades > 0 ? totalLossSol / losingTrades : 0;

  const totalPnlSol = realizedPnlSol + unrealizedPnlSol;
  const totalPnlPercent =
    totalInvestedSol > 0 ? (totalPnlSol / totalInvestedSol) * 100 : 0;

  const roi =
    totalInvestedSol > 0
      ? ((totalReturnedSol - totalInvestedSol) / totalInvestedSol) * 100
      : 0;

  return {
    totalInvestedSol,
    totalReturnedSol,
    unrealizedPnlSol,
    realizedPnlSol,
    totalPnlSol,
    totalPnlPercent,
    winningTrades,
    losingTrades,
    totalTrades,
    winRate,
    averageWinSol,
    averageLossSol,
    largestWinSol,
    largestLossSol,
    openPositionsValue,
    closedPositionsValue: totalReturnedSol,
    roi,
  };
}

/**
 * Get P&L breakdown by token
 */
export async function getTokenPnL(): Promise<TokenPnL[]> {
  if (!db) await connect();

  const trades = await tradesCol!.find({}).sort({ timestamp: 1 }).toArray();
  const tokenMap = new Map<
    string,
    {
      totalBought: number;
      totalSold: number;
      buyCount: number;
      sellCount: number;
      symbol?: string;
    }
  >();

  for (const trade of trades) {
    const token = trade.token;
    if (!tokenMap.has(token)) {
      tokenMap.set(token, {
        totalBought: 0,
        totalSold: 0,
        buyCount: 0,
        sellCount: 0,
      });
    }

    const data = tokenMap.get(token)!;
    if (trade.type === "buy") {
      data.totalBought += trade.amountSol;
      data.buyCount++;
    } else if (trade.type === "sell") {
      data.totalSold += trade.amountSol;
      data.sellCount++;
    }
  }

  const tokenPnLs: TokenPnL[] = [];

  for (const [token, data] of tokenMap.entries()) {
    const pnlSol = data.totalSold - data.totalBought;
    const pnlPercent =
      data.totalBought > 0 ? (pnlSol / data.totalBought) * 100 : 0;

    const averageBuyPrice =
      data.buyCount > 0 ? data.totalBought / data.buyCount : 0;

    const status = data.totalSold >= data.totalBought ? "closed" : "open";
    const remainingTokens = data.totalBought - data.totalSold;

    tokenPnLs.push({
      token,
      symbol: token.substring(0, 8) + "...",
      totalBought: data.totalBought,
      totalSold: data.totalSold,
      remainingTokens,
      averageBuyPrice,
      pnlSol,
      pnlPercent,
      trades: data.buyCount + data.sellCount,
      status,
    });
  }

  // Sort by absolute P&L (largest gains/losses first)
  return tokenPnLs.sort((a, b) => Math.abs(b.pnlSol) - Math.abs(a.pnlSol));
}

/**
 * Get P&L history over time (daily aggregation)
 */
export async function getPnLHistory(days: number = 30): Promise<
  Array<{
    date: string;
    realizedPnlSol: number;
    tradeCount: number;
    winRate: number;
  }>
> {
  if (!db) await connect();

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const trades = await tradesCol!
    .find({
      timestamp: { $gte: startDate },
      type: "sell",
    })
    .sort({ timestamp: 1 })
    .toArray();

  const dailyMap = new Map<
    string,
    {
      pnl: number;
      wins: number;
      losses: number;
    }
  >();

  for (const trade of trades) {
    const dateKey = trade.timestamp.toISOString().split("T")[0];
    if (!dateKey) continue;

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, { pnl: 0, wins: 0, losses: 0 });
    }

    const day = dailyMap.get(dateKey)!;
    day.pnl += trade.pnlSol || 0;

    if (trade.pnlSol && trade.pnlSol > 0) day.wins++;
    else if (trade.pnlSol && trade.pnlSol < 0) day.losses++;
  }

  const history = Array.from(dailyMap.entries()).map(([date, data]) => {
    const total = data.wins + data.losses;
    return {
      date,
      realizedPnlSol: data.pnl,
      tradeCount: total,
      winRate: total > 0 ? (data.wins / total) * 100 : 0,
    };
  });

  return history.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Token State Management (for new trade rules)
 */
export async function upsertTokenState(
  tokenState: Omit<TokenState, "_id" | "updatedAt">
): Promise<void> {
  if (!db) await connect();

  // Separate detectedAt from other fields to avoid MongoDB conflict
  const { detectedAt, ...updateFields } = tokenState;

  await tokenStateCol!.updateOne(
    { mint: tokenState.mint },
    {
      $set: {
        ...updateFields,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        detectedAt: detectedAt || new Date(),
      },
    },
    { upsert: true }
  );
}

export async function getTokenState(mint: string): Promise<TokenState | null> {
  if (!db) await connect();
  return await tokenStateCol!.findOne({ mint });
}

export async function getTokensByState(
  state: TokenLifecycleState
): Promise<TokenState[]> {
  if (!db) await connect();
  return await tokenStateCol!.find({ state }).sort({ updatedAt: -1 }).toArray();
}

export async function getTokensByStates(
  states: TokenLifecycleState[],
  options?: {
    limit?: number;
    minCreatedAt?: Date;
    hasRaydiumPool?: boolean;
  }
): Promise<TokenState[]> {
  if (!db) await connect();

  const filter: any = { state: { $in: states } };

  if (options?.minCreatedAt) {
    filter.detectedAt = { $gte: options.minCreatedAt };
  }

  if (options?.hasRaydiumPool) {
    filter.poolAddress = { $exists: true, $ne: null };
  }

  let query = tokenStateCol!.find(filter).sort({ updatedAt: -1 });

  if (options?.limit) {
    query = query.limit(options.limit);
  }

  return await query.toArray();
}

export async function updateTokenState(
  mint: string,
  updates: Partial<Omit<TokenState, "_id" | "mint">>
): Promise<void> {
  if (!db) await connect();
  await tokenStateCol!.updateOne(
    { mint },
    {
      $set: {
        ...updates,
        updatedAt: new Date(),
      },
    }
  );
}

export async function blacklistToken(
  mint: string,
  reason: string
): Promise<void> {
  if (!db) await connect();
  await tokenStateCol!.updateOne(
    { mint },
    {
      $set: {
        state: "BLACKLISTED",
        blacklistedAt: new Date(),
        blacklistReason: reason,
        updatedAt: new Date(),
      },
    }
  );
}

export async function close() {
  if (client) {
    await client.close();
    client = null;
  }
}

export default {
  connect,
  addTrade,
  getTrades,
  getStats,
  getPositions,
  updateStats,
  updatePositionMetadata,
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  updateWatchlistAlert,
  getPortfolioPnL,
  getTokenPnL,
  getPnLHistory,
  upsertTokenState,
  getTokenState,
  getTokensByState,
  getTokensByStates,
  updateTokenState,
  blacklistToken,
  close,
};
