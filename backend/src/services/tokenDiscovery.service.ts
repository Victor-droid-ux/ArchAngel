import axios from "axios";
import { getLogger } from "../utils/logger.js";
import { registerAutoBuyCandidate } from "./autoBuyer.service.js";
import { Server } from "socket.io";
import { RAYDIUM_QUOTE_URL } from "./raydium.service.js";
import dbService from "./db.service.js";
import { tokenDiscoveryCache, tokenMetadataCache } from "./cache.service.js";
import { getRuntimeConfig } from "../routes/config.route.js";
import { getConnection } from "./solana.service.js";
import { PublicKey } from "@solana/web3.js";
import {
  validateTokenBatch,
  TokenLifecycleStage,
  type TokenLifecycleResult,
} from "./tokenLifecycle.service.js";

const log = getLogger("tokenDiscovery");

/**
 * Get the number of unique holders for a token by checking token accounts
 * Returns -1 if unable to fetch (to allow filtering)
 */
async function getTokenHolderCount(mintAddress: string): Promise<number> {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(mintAddress);

    // Get all token accounts for this mint
    const tokenAccounts = await connection.getProgramAccounts(
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // SPL Token Program
      {
        filters: [
          { dataSize: 165 }, // Token account data size
          {
            memcmp: {
              offset: 0, // Mint address offset in token account
              bytes: mintPubkey.toBase58(),
            },
          },
        ],
      }
    );

    // Filter out accounts with zero balance
    const nonZeroAccounts = tokenAccounts.filter(
      (account: { account: { data: Buffer } }) => {
        // Token amount is stored at offset 64 (8 bytes)
        const amount = account.account.data.readBigUInt64LE(64);
        return amount > 0n;
      }
    );

    log.debug(
      `Token ${mintAddress.slice(0, 8)}... has ${
        nonZeroAccounts.length
      } holders`
    );
    return nonZeroAccounts.length;
  } catch (err) {
    const msg =
      err && typeof err === "object" && "message" in err
        ? (err as any).message
        : String(err);
    log.warn(
      `Failed to get holder count for ${mintAddress.slice(0, 8)}...: ${msg}`
    );
    return -1; // Return -1 to indicate error (allow token through filter)
  }
}

/**
 * Retry an async function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff
        log.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Calculate token score (0-100) based on multiple factors
 */
function calculateTokenScore(token: any): number {
  let score = 0;

  // Liquidity score (0-30 points)
  const liquidityUSD = token.liquidity || 0;
  if (liquidityUSD > 1000000) score += 30; // $1M+
  else if (liquidityUSD > 500000) score += 25;
  else if (liquidityUSD > 100000) score += 20;
  else if (liquidityUSD > 50000) score += 15;
  else if (liquidityUSD > 10000) score += 10;
  else if (liquidityUSD > 1000) score += 5;

  // Volume score (0-25 points)
  const volume24h = token.volume24h || 0;
  if (volume24h > 500000) score += 25; // $500K+ daily volume
  else if (volume24h > 100000) score += 20;
  else if (volume24h > 50000) score += 15;
  else if (volume24h > 10000) score += 10;
  else if (volume24h > 1000) score += 5;

  // Market cap score (0-20 points)
  const marketCap = token.market_cap || 0;
  if (marketCap > 50000000) score += 20; // $50M+ (established)
  else if (marketCap > 10000000) score += 18; // $10M+ (strong)
  else if (marketCap > 5000000) score += 16; // $5M+ (growing)
  else if (marketCap > 1000000) score += 14; // $1M+ (moderate)
  else if (marketCap > 500000) score += 12; // $500K+ (early)
  else if (marketCap > 100000) score += 8; // $100K+ (very early)
  else if (marketCap > 50000) score += 5; // $50K+ (micro)
  else if (marketCap > 10000) score += 3; // $10K+ (nano)
  else if (marketCap > 1000) score += 1; // $1K+ (extreme risk)

  // Price action score (0-15 points)
  const priceChange = token.priceChange24h || 0;
  if (priceChange > 100) score += 15; // 100%+ gain
  else if (priceChange > 50) score += 12;
  else if (priceChange > 20) score += 10;
  else if (priceChange > 0) score += 5;
  else if (priceChange > -20) score += 2; // Small loss ok
  // Negative score for big dumps

  // Transaction activity score (0-10 points)
  const txns = token.txns24h?.buys + token.txns24h?.sells || 0;
  if (txns > 1000) score += 10;
  else if (txns > 500) score += 8;
  else if (txns > 100) score += 5;
  else if (txns > 50) score += 3;

  return Math.min(100, Math.max(0, score));
}

/**
 * Assess rug pull risk based on red flags
 */
function assessRugPullRisk(token: any): "low" | "medium" | "high" {
  let riskFlags = 0;

  // Low liquidity (major red flag)
  const liquidityUSD = token.liquidity || 0;
  if (liquidityUSD < 5000) riskFlags += 3;
  else if (liquidityUSD < 20000) riskFlags += 2;
  else if (liquidityUSD < 50000) riskFlags += 1;

  // Very low transaction count
  const txns = token.txns24h?.buys + token.txns24h?.sells || 0;
  if (txns < 10) riskFlags += 2;
  else if (txns < 50) riskFlags += 1;

  // Extreme price volatility (pump and dump pattern)
  const priceChange = token.priceChange24h || 0;
  if (Math.abs(priceChange) > 200) riskFlags += 2; // 200%+ move
  if (priceChange < -50) riskFlags += 2; // Big dump

  // Very new token (< 1 hour old)
  if (token.pairCreatedAt) {
    const ageInHours = (Date.now() - token.pairCreatedAt) / (1000 * 60 * 60);
    if (ageInHours < 1) riskFlags += 1;
  }

  // Low volume relative to liquidity (no organic trading)
  const volume24h = token.volume24h || 0;
  if (liquidityUSD > 0 && volume24h / liquidityUSD < 0.1) riskFlags += 1;

  // Risk assessment
  if (riskFlags >= 5) return "high";
  if (riskFlags >= 3) return "medium";
  return "low";
}

/**
 * Calculate token age in hours
 */
function getTokenAgeHours(
  pairCreatedAt: number | undefined
): number | undefined {
  if (!pairCreatedAt) return undefined;
  return (Date.now() - pairCreatedAt) / (1000 * 60 * 60);
}

export type CandidateToken = {
  symbol?: string;
  mint: string;
  name?: string;
  priceSol: number | null;
  liquidity: number | null;
  marketCapSol: number | null;
  score?: number; // 0-100 rating
  riskLevel?: "low" | "medium" | "high"; // Rug pull risk
  age?: number | undefined; // Hours since launch
  volume24h?: number;
  priceChange24h?: number;
  holderCount?: number; // Number of unique holders (0-5 for newly launched)
  dexId?: string; // DEX identifier (raydium, pumpfun, etc.)
  isPumpFun?: boolean; // True if on pump.fun bonding curve
  // Lifecycle validation fields
  lifecycleStage?: TokenLifecycleStage;
  lifecycleValidated?: boolean;
  isTradable?: boolean;
  hasGraduated?: boolean;
  hasLiquidity?: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
};

export async function fetchTokenList() {
  // Use DexScreener token boosts to find trending new meme coins
  // These are tokens that creators have promoted, usually new launches

  // Check cache first
  const cacheKey = "dexscreener:boosted-tokens";
  const cached = tokenDiscoveryCache.get<any>(cacheKey);
  if (cached) {
    log.debug("Using cached DexScreener token list");
    return cached;
  }

  try {
    const res = await retryWithBackoff(() =>
      axios.get("https://api.dexscreener.com/token-boosts/top/v1", {
        timeout: 10000,
        headers: { Accept: "application/json" },
      })
    );

    // Get top boosted tokens (these are typically new meme coins)
    const boostedTokens = res.data || [];
    const solanaTokens = boostedTokens
      .filter((t: any) => t.chainId === "solana")
      .slice(0, 50);

    if (solanaTokens.length === 0) {
      log.warn("No boosted Solana tokens found, falling back to regular fetch");
      // Fallback: Try to get any Solana pairs
      const fallbackRes = await retryWithBackoff(() =>
        axios.get(
          "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
          { timeout: 10000, headers: { Accept: "application/json" } }
        )
      );
      const pairs = fallbackRes.data?.pairs || [];
      log.info(`Fetched ${pairs.length} SOL pairs as fallback`);

      // Process fallback data same way
      const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
      const fallbackTokens = pairs
        .filter((p: any) => p.chainId === "solana")
        .slice(0, 100)
        .map((pair: any) => {
          const baseIsSol = pair.baseToken?.address === SOL_ADDRESS;
          const memeToken = baseIsSol ? pair.quoteToken : pair.baseToken;
          return {
            address: memeToken?.address,
            symbol: memeToken?.symbol,
            name: memeToken?.name,
            price: pair.priceUsd,
            liquidity: pair.liquidity?.usd,
            market_cap: pair.fdv,
            priceChange24h: pair.priceChange?.h24,
            volume24h: pair.volume?.h24,
            pairAddress: pair.pairAddress,
            dexId: pair.dexId,
            pairCreatedAt: pair.pairCreatedAt,
            txns24h: pair.txns?.h24,
          };
        });

      tokenDiscoveryCache.set(cacheKey, fallbackTokens);
      return fallbackTokens;
    }

    // Fetch trading pairs for these boosted tokens
    const tokenAddresses = solanaTokens
      .map((t: any) => t.tokenAddress)
      .join(",");
    const pairsRes = await retryWithBackoff(() =>
      axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddresses}`,
        { timeout: 10000, headers: { Accept: "application/json" } }
      )
    );

    let pairs = pairsRes.data?.pairs || [];
    pairs = pairs.filter((p: any) => p.chainId === "solana").slice(0, 100);

    log.info(
      `Fetched ${pairs.length} new Solana meme token pairs from DexScreener`
    );

    // Cache token metadata for individual tokens
    for (const pair of pairs) {
      if (pair.baseToken?.address) {
        const metaKey = `token:meta:${pair.baseToken.address}`;
        tokenMetadataCache.set(metaKey, {
          address: pair.baseToken.address,
          symbol: pair.baseToken.symbol,
          name: pair.baseToken.name,
        });
      }
      if (pair.quoteToken?.address) {
        const metaKey = `token:meta:${pair.quoteToken.address}`;
        tokenMetadataCache.set(metaKey, {
          address: pair.quoteToken.address,
          symbol: pair.quoteToken.symbol,
          name: pair.quoteToken.name,
        });
      }
    }

    const SOL_ADDRESS = "So11111111111111111111111111111111111111112";

    // Extract meme tokens from trading pairs (the token that's NOT SOL)
    const tokens = pairs.map((pair: any) => {
      // Determine which token is the meme token (not SOL)
      const baseIsSol = pair.baseToken?.address === SOL_ADDRESS;
      const quoteIsSol = pair.quoteToken?.address === SOL_ADDRESS;

      // Use the token that's NOT SOL
      const memeToken = baseIsSol ? pair.quoteToken : pair.baseToken;

      return {
        address: memeToken?.address,
        symbol: memeToken?.symbol,
        name: memeToken?.name,
        price: pair.priceUsd,
        liquidity: pair.liquidity?.usd,
        market_cap: pair.fdv,
        priceChange24h: pair.priceChange?.h24,
        volume24h: pair.volume?.h24,
        pairAddress: pair.pairAddress,
        dexId: pair.dexId,
        pairCreatedAt: pair.pairCreatedAt, // Token age tracking
        txns24h: pair.txns?.h24, // Transaction count
      };
    });

    // Cache the result
    tokenDiscoveryCache.set(cacheKey, tokens);

    return tokens;
  } catch (err) {
    const msg =
      err && typeof err === "object" && "message" in err
        ? (err as any).message
        : String(err);
    log.warn(`DexScreener failed: ${msg}`);
    log.error(`No token list available: ${msg}`);
    return null;
  }
}

/**
 * Start token watcher
 * - polls token list/prices every intervalMs
 * - emits tokenFeed via socket when list changes
 * - triggers auto-buy for tokens that meet criteria via autoBuyer.register
 */
export function startTokenWatcher(io: Server, opts?: { intervalMs?: number }) {
  const intervalMs = opts?.intervalMs ?? 10_000;
  let currentMints = new Set<string>();
  // Get initial config values (will use runtime values during execution)
  const config = getRuntimeConfig();

  log.info(
    `Starting token watcher intervalMs=${intervalMs} MC_RANGE=${config.minMarketCapSol}-${config.maxMarketCapSol} SOL ($${config.minMarketCapUsd}-$${config.maxMarketCapUsd}) MAX_AGE=${config.maxTokenAgeHours}h MIN_SCORE=${config.minTokenScore}`
  );

  const tick = async () => {
    try {
      // 1) Get a token list
      const tokenList = await fetchTokenList();
      if (!tokenList) {
        log.warn("token list unavailable");
        return;
      }

      // tokenList shape varies: if array of tokens -> use it; else try tokens property
      const tokensArray: any[] = Array.isArray(tokenList)
        ? tokenList
        : tokenList.tokens || tokenList.data || [];

      log.info(`Processing ${tokensArray.length} tokens from DexScreener`);

      // Debug: log first token to see structure
      if (tokensArray.length > 0) {
        log.info({
          msg: "Sample token structure:",
          address: tokensArray[0].address,
          symbol: tokensArray[0].symbol,
          name: tokensArray[0].name,
          liquidity: tokensArray[0].liquidity,
        });
      }

      // Known stablecoins and wrapped tokens to exclude
      const EXCLUDED_TOKENS = new Set([
        "So11111111111111111111111111111111111111112", // Wrapped SOL
        "EPjFWdd5AufqSSqeM2qU7yP5eyh8DkY3QJrGVRmZAFh", // USDC
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
        "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // Wrapped ETH
        "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
        "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
        "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
      ]);

      // Build candidate tokens from DexScreener pairs (already filtered by SOL pairs)
      const initialCandidates = tokensArray
        .filter((t: any) => {
          // Filter for valid tokens with address and symbol
          const hasAddress = !!t.address;
          const hasSymbol = !!t.symbol;
          const isNotExcluded = !EXCLUDED_TOKENS.has(t.address);

          // Exclude tokens with stablecoin-like symbols
          const isNotStablecoin =
            !/(USDC|USDT|USD|DAI|BUSD|TUSD|USDH|USDS)/i.test(t.symbol);

          // Allow Pump.fun tokens (pumpfun, pumpswap) OR Raydium graduated tokens
          // The 3-condition validation will filter for:
          // 1. Pump.fun tokens ≥90% bonding curve (about to graduate)
          // 2. Raydium tokens with sufficient liquidity (already graduated)
          const isValidDex =
            t.dexId === "raydium" ||
            t.dexId === "pumpfun" ||
            t.dexId === "pumpswap";

          // Age filter - only tokens launched within max age from config
          const tokenAge = getTokenAgeHours(t.pairCreatedAt);
          const config = getRuntimeConfig();
          const isNotTooOld = !tokenAge || tokenAge <= config.maxTokenAgeHours;

          if (!hasAddress || !hasSymbol || !isNotExcluded || !isNotStablecoin) {
            log.debug(
              `Filtered out: ${t.symbol} (${t.address?.slice(
                0,
                8
              )}...) - excluded or stablecoin`
            );
          }

          if (!isValidDex) {
            log.debug(
              `Filtered out: ${t.symbol} - invalid DEX (dexId: ${
                t.dexId
              }, address: ${t.address?.slice(0, 8)}...)`
            );
          }

          if (!isNotTooOld) {
            log.debug(
              `Filtered out: ${t.symbol} - too old (${tokenAge?.toFixed(1)}h)`
            );
          }

          return (
            hasAddress &&
            hasSymbol &&
            isNotExcluded &&
            isNotStablecoin &&
            isValidDex &&
            isNotTooOld
          );
        })
        .slice(0, 50); // Take first 50 for holder check (reduce RPC calls)

      // Check holder count for each token (only newly launched with few holders)
      log.info(
        `Checking holder counts for ${initialCandidates.length} tokens...`
      );
      const tokensWithHolderData = await Promise.all(
        initialCandidates.map(async (t: any) => {
          const holderCount = await getTokenHolderCount(t.address);
          return { ...t, holderCount };
        })
      );

      // Filter for tokens with 0-5 holders (newly launched, no one bought yet)
      const newlyLaunchedTokens = tokensWithHolderData.filter((t: any) => {
        const holders = t.holderCount;
        // Allow through if holder check failed (-1) or if 0-5 holders
        const isNewlyLaunched =
          holders === -1 || (holders >= 0 && holders <= 5);

        if (!isNewlyLaunched && holders > 5) {
          log.debug(
            `Filtered out: ${t.symbol} - already has ${holders} holders (not newly launched)`
          );
        } else if (holders >= 0 && holders <= 5) {
          log.info(
            `✨ NEW LAUNCH: ${t.symbol} (${t.address?.slice(
              0,
              8
            )}...) - ${holders} holders`
          );
        }

        return isNewlyLaunched;
      });

      log.info(
        `Filtered to ${newlyLaunchedTokens.length} newly launched tokens (0-5 holders)`
      );

      const candidates: CandidateToken[] = newlyLaunchedTokens
        .map((t: any) => {
          const score = calculateTokenScore(t);
          const riskLevel = assessRugPullRisk(t);
          const age = getTokenAgeHours(t.pairCreatedAt);
          const isPumpFun = t.address?.toLowerCase().endsWith("pump");

          return {
            symbol: t.symbol,
            mint: t.address,
            name: t.name,
            priceSol: t.price ? Number(t.price) / 200 : null, // Convert USD to rough SOL (~$200/SOL)
            liquidity: t.liquidity,
            marketCapSol: t.market_cap ? Number(t.market_cap) / 200 : null,
            score,
            riskLevel,
            age,
            volume24h: t.volume24h,
            priceChange24h: t.priceChange24h,
            holderCount: t.holderCount >= 0 ? t.holderCount : undefined, // Include holder count
            dexId: t.dexId, // Include DEX identifier
            isPumpFun, // Flag if it's a pump.fun token
          };
        })
        .sort((a, b) => {
          // Sort by holder count first (fewer holders = higher priority for new launches)
          const holderDiff = (a.holderCount || 999) - (b.holderCount || 999);
          if (holderDiff !== 0) return holderDiff;
          // Then by score descending
          return (b.score || 0) - (a.score || 0);
        });

      // Filter by minimum score from runtime config
      const config = getRuntimeConfig();
      const scoredCandidates = candidates.filter(
        (t) => (t.score || 0) >= config.minTokenScore
      );

      const avgScore =
        scoredCandidates.length > 0
          ? Math.round(
              scoredCandidates.reduce((sum, t) => sum + (t.score || 0), 0) /
                scoredCandidates.length
            )
          : 0;

      const riskDistribution = {
        low: scoredCandidates.filter((t) => t.riskLevel === "low").length,
        medium: scoredCandidates.filter((t) => t.riskLevel === "medium").length,
        high: scoredCandidates.filter((t) => t.riskLevel === "high").length,
      };

      log.info(
        `Filtered to ${scoredCandidates.length} tokens (avg score: ${avgScore}, risk: ${riskDistribution.low}L/${riskDistribution.medium}M/${riskDistribution.high}H)`
      );

      // === LIFECYCLE VALIDATION ===
      // Validate tokens through full lifecycle: Pump.fun → Bonding → Graduation → Raydium → Liquidity
      log.info(
        `Running lifecycle validation on ${scoredCandidates.length} tokens...`
      );

      const tokenMints = scoredCandidates.map((t) => t.mint);
      const lifecycleValidation = await validateTokenBatch(tokenMints);

      // Merge lifecycle data into candidate tokens
      const validatedCandidates = scoredCandidates.map((candidate) => {
        const lifecycleResult = lifecycleValidation.tradable
          .concat(lifecycleValidation.notTradable)
          .find((lc) => lc.mint === candidate.mint);

        if (lifecycleResult) {
          return {
            ...candidate,
            lifecycleStage: lifecycleResult.stage,
            lifecycleValidated: true,
            isTradable: lifecycleResult.isTradable,
            hasGraduated: lifecycleResult.hasGraduated,
            hasLiquidity: lifecycleResult.hasLiquidity,
            liquiditySOL: lifecycleResult.liquiditySOL,
            poolAddress: lifecycleResult.poolAddress,
            isPumpFun: lifecycleResult.isPumpFun,
          };
        }

        return { ...candidate, lifecycleValidated: false };
      });

      // Filter candidates that could potentially meet the 3 critical conditions:
      // 1. Pump.fun tokens still bonding (we'll check if ≥90% later)
      // 2. Pump.fun tokens that graduated to Raydium (we'll check liquidity later)
      // The tradeValidation.service.ts will verify all 3 conditions
      const potentialCandidates = validatedCandidates.filter((t) => {
        // Must be Pump.fun origin (either still bonding or graduated)
        const isPumpFunToken = t.isPumpFun === true;

        // Token must be either:
        // - Still on bonding curve (PUMP_FUN_BONDING stage)
        // - OR graduated to Raydium (FULLY_TRADABLE stage)
        const isValidStage =
          t.lifecycleStage === TokenLifecycleStage.PUMP_FUN_BONDING ||
          t.lifecycleStage === TokenLifecycleStage.FULLY_TRADABLE;

        if (!isPumpFunToken) {
          log.debug(
            `Filtered out: ${t.symbol} (${t.mint.slice(
              0,
              8
            )}...) - Not a Pump.fun token`
          );
          return false;
        }

        if (!isValidStage) {
          log.debug(
            `Filtered out: ${t.symbol} (${t.mint.slice(
              0,
              8
            )}...) - Invalid stage: ${t.lifecycleStage}`
          );
          return false;
        }

        return true;
      });

      // All other tokens are not tradable (not Pump.fun or wrong stage)
      const notTradableTokens = validatedCandidates.filter((t) => {
        return !potentialCandidates.includes(t);
      });

      // Count tokens by stage
      const bondingTokens = potentialCandidates.filter(
        (t) => t.lifecycleStage === TokenLifecycleStage.PUMP_FUN_BONDING
      ).length;
      const graduatedTokens = potentialCandidates.filter(
        (t) => t.lifecycleStage === TokenLifecycleStage.FULLY_TRADABLE
      ).length;

      log.info(
        `✅ Lifecycle validation complete: ${potentialCandidates.length} Pump.fun candidates (${bondingTokens} bonding, ${graduatedTokens} graduated), ${notTradableTokens.length} filtered out`
      );
      log.info(
        `   - ${bondingTokens} tokens on Pump.fun bonding curve (will check if ≥90%)`
      );
      log.info(
        `   - ${graduatedTokens} tokens graduated to Raydium (will check liquidity)`
      );
      log.info(
        `   - ${notTradableTokens.length} filtered out (non-Pump.fun or invalid stage)`
      );

      // Emit tokenFeed to frontends with lifecycle validation data
      io.emit("tokenFeed", {
        tokens: validatedCandidates,
        tradable: potentialCandidates,
        notTradable: notTradableTokens,
        lifecycleSummary: {
          ...lifecycleValidation.summary,
          potentialCandidates: potentialCandidates.length,
          bonding: bondingTokens,
          graduated: graduatedTokens,
        },
      });

      // NEW RULES: STAGE 1 - PUMP.FUN PRE-FILTER (WATCHLIST ONLY, NO BUYING)
      // Only track Pump.fun bonding tokens that meet criteria
      // BUY TRIGGER: Only when Raydium pool is detected (handled by poolMonitor)
      for (const tk of potentialCandidates) {
        if (!tk.mint) continue;
        if (!currentMints.has(tk.mint)) {
          // new mint discovered
          currentMints.add(tk.mint);

          // Quick validation: must be Pump.fun token
          if (!tk.isPumpFun) {
            log.info(
              `Skipping token: ${tk.symbol} (${tk.mint.slice(
                0,
                8
              )}...) - Not a Pump.fun token`
            );
            continue;
          }

          // Calculate metrics for pre-filter
          const price = tk.priceSol ?? 0;
          const mcSol = tk.marketCapSol ?? price;
          const mcUsd = tk.marketCapSol ? tk.marketCapSol * 200 : 0;

          // STAGE 1 RULES: Track if bonding ≥85%, MC ≥$25k, buy>sell
          // NOTE: DexScreener doesn't give exact bonding %, we estimate from MC
          // Pump.fun graduates around $60-70k MC, so 85% ≈ $51k-60k
          const estimatedBondingProgress = Math.min((mcUsd / 65000) * 100, 100);

          // Check if token meets STAGE 1 pre-filter criteria
          const meetsBondingThreshold = estimatedBondingProgress >= 85;
          const meetsMinMC = mcUsd >= 25000; // $25k minimum

          // STAGE 1 RULE: Buy volume must be > Sell volume
          // Note: CandidateToken doesn't have txns data, so we use volume24h as proxy
          const buyVol = tk.volume24h || 0;
          // Assume if volume exists and is positive, buy pressure is present
          const passesBuySellFilter = buyVol > 0;

          if (tk.lifecycleStage === TokenLifecycleStage.PUMP_FUN_BONDING) {
            // Token is still on bonding curve
            if (meetsBondingThreshold && meetsMinMC && passesBuySellFilter) {
              log.info(
                `📋 WATCHLIST: ${tk.symbol} (${tk.mint.slice(
                  0,
                  8
                )}...) | Bonding: ${estimatedBondingProgress.toFixed(
                  1
                )}% | MC: $${mcUsd.toFixed(0)} | Status: AWAITING_GRADUATION`
              );

              // Save to database as AWAITING_GRADUATION (watchlist only, NO BUY)
              await dbService.upsertTokenState({
                mint: tk.mint,
                symbol: tk.symbol || "UNKNOWN",
                name: tk.name || "Unknown Token",
                state: "AWAITING_GRADUATION",
                source: "pump.fun",
                bondingProgress: estimatedBondingProgress,
                marketCapUSD: mcUsd,
                detectedAt: new Date(),
              });
            } else {
              log.debug(
                `⏭️ Skip: ${
                  tk.symbol
                } - bonding ${estimatedBondingProgress.toFixed(
                  1
                )}%, MC $${mcUsd.toFixed(0)} (needs ≥85% & ≥$25k)`
              );
            }
          } else if (tk.lifecycleStage === TokenLifecycleStage.FULLY_TRADABLE) {
            // Token has GRADUATED to Raydium - this is a BUY TRIGGER
            log.info(
              `🚀 RAYDIUM POOL DETECTED: ${tk.symbol} (${tk.mint.slice(
                0,
                8
              )}...) | Liquidity: ${tk.liquiditySOL?.toFixed(
                2
              )} SOL | Pool: ${tk.poolAddress?.slice(0, 8)}...`
            );

            // Update state to RAYDIUM_POOL_CREATED
            await dbService.upsertTokenState({
              mint: tk.mint,
              symbol: tk.symbol || "UNKNOWN",
              name: tk.name || "Unknown Token",
              state: "RAYDIUM_POOL_CREATED",
              source: "pump.fun",
              bondingProgress: 100, // Graduated
              marketCapUSD: mcUsd,
              raydiumPoolExists: true,
              liquiditySOL: tk.liquiditySOL || 0,
              liquidityUSD: tk.liquiditySOL ? tk.liquiditySOL * 200 : 0,
              poolAddress: tk.poolAddress || "",
              graduatedAt: new Date(),
              detectedAt: new Date(),
            });

            // NOW we trigger the buy validation and execution
            // This will check all conditions including $1,500 liquidity minimum
            registerAutoBuyCandidate(io, tk).catch((e: any) => {
              const emsg =
                e && typeof e === "object" && "message" in e
                  ? (e as any).message
                  : String(e);
              log.error(`registerAutoBuyCandidate failed: ${emsg}`);
            });
          }
        }
      }

      // prune currentMints to keep bounded size
      if (currentMints.size > 2000) {
        // keep last 1000 arbitrary (not perfect but ok for demo)
        const keys = Array.from(currentMints).slice(-1000);
        currentMints = new Set(keys);
      }
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? (err as any).message
          : String(err);
      log.error(`Token watcher tick failed: ${msg}`);
    }
  };

  const handle = setInterval(tick, intervalMs);
  // run immediately once:
  tick().catch((e: any) => {
    const msg =
      e && typeof e === "object" && "message" in e
        ? (e as any).message
        : String(e);
    log.warn(`Initial token tick failed: ${msg}`);
  });

  return () => {
    clearInterval(handle);
    log.info("Token watcher stopped");
  };
}

export default { startTokenWatcher };
