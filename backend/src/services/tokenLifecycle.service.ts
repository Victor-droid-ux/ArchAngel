import { getConnection } from "./solana.service.js";
import {
  isPumpFunToken,
  getPumpFunBondingCurve,
  isGraduatedPumpFunToken,
} from "./pumpfun.service.js";
import { getRaydiumQuote } from "./raydium.service.js";
import { getLogger } from "../utils/logger.js";
import { PublicKey } from "@solana/web3.js";

const log = getLogger("tokenLifecycle");

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Token lifecycle stages
 */
export enum TokenLifecycleStage {
  PUMP_FUN_BONDING = "pump_fun_bonding", // On pump.fun bonding curve
  GRADUATED_NO_POOL = "graduated_no_pool", // Graduated but no Raydium pool yet
  GRADUATED_ZERO_LIQUIDITY = "graduated_zero_liquidity", // Pool exists but no liquidity
  FULLY_TRADABLE = "fully_tradable", // Graduated with active liquidity
  UNKNOWN = "unknown", // Unable to determine status
}

/**
 * Token lifecycle validation result
 */
export interface TokenLifecycleResult {
  mint: string;
  stage: TokenLifecycleStage;
  isPumpFun: boolean;
  hasBondingCurve: boolean;
  hasGraduated: boolean;
  hasRaydiumPool: boolean;
  hasLiquidity: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
  isTradable: boolean;
  errorMessage?: string;
  timestamp: number;
}

/**
 * Check if Raydium pool has active liquidity by attempting a small quote
 */
async function checkRaydiumLiquidity(tokenMint: string): Promise<{
  hasLiquidity: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
}> {
  try {
    // Try to get a quote for a small amount (0.001 SOL)
    const smallAmountLamports = 1_000_000; // 0.001 SOL
    const quote = await getRaydiumQuote(
      SOL_MINT,
      tokenMint,
      smallAmountLamports,
      1
    );

    if (!quote || !quote.poolKeys) {
      return { hasLiquidity: false };
    }

    // If we got a valid quote, the pool exists with liquidity
    const poolAddress = quote.poolKeys.id?.toBase58();

    // Try to get liquidity info from pool state
    let liquiditySOL: number | undefined;
    try {
      const connection = getConnection();
      const poolId = quote.poolKeys.id;

      if (poolId) {
        const poolState = await connection.getAccountInfo(poolId);
        if (poolState && poolState.data.length >= 104) {
          // Raydium pool state has base and quote reserves
          // Base reserve is at offset 80 (8 bytes)
          // Quote reserve is at offset 88 (8 bytes)
          const baseReserve = poolState.data.readBigUInt64LE(80);
          const quoteReserve = poolState.data.readBigUInt64LE(88);

          // Determine which reserve is SOL (assuming SOL is always base or quote)
          const solReserve =
            quote.poolKeys.baseMint.toBase58() === SOL_MINT
              ? baseReserve
              : quoteReserve;

          liquiditySOL = Number(solReserve) / 1e9; // Convert lamports to SOL

          log.debug(
            `Pool ${poolAddress?.slice(0, 8)}... has ${liquiditySOL.toFixed(
              2
            )} SOL liquidity`
          );
        }
      }
    } catch (err) {
      log.debug(`Could not fetch detailed liquidity info: ${err}`);
      // Non-fatal, we still know pool exists
    }

    const result: {
      hasLiquidity: boolean;
      liquiditySOL?: number;
      poolAddress?: string;
    } = {
      hasLiquidity: true,
    };

    if (liquiditySOL !== undefined) {
      result.liquiditySOL = liquiditySOL;
    }
    if (poolAddress !== undefined) {
      result.poolAddress = poolAddress;
    }

    return result;
  } catch (err) {
    log.debug(`Raydium liquidity check failed: ${err}`);
    return { hasLiquidity: false };
  }
}

/**
 * Validate token's full lifecycle status
 * Checks: Pump.fun origin → bonding curve → graduation → Raydium pool → liquidity
 */
export async function validateTokenLifecycle(
  tokenMint: string
): Promise<TokenLifecycleResult> {
  const result: TokenLifecycleResult = {
    mint: tokenMint,
    stage: TokenLifecycleStage.UNKNOWN,
    isPumpFun: false,
    hasBondingCurve: false,
    hasGraduated: false,
    hasRaydiumPool: false,
    hasLiquidity: false,
    isTradable: false,
    timestamp: Date.now(),
  };

  try {
    log.info(`Validating lifecycle for token ${tokenMint.slice(0, 8)}...`);

    // Step 1: Check if token originated from Pump.fun
    const bondingCurveExists = await isPumpFunToken(tokenMint);
    result.hasBondingCurve = bondingCurveExists;

    // Step 2: If bonding curve exists, token is still on Pump.fun
    if (bondingCurveExists) {
      result.isPumpFun = true;
      result.stage = TokenLifecycleStage.PUMP_FUN_BONDING;
      result.isTradable = true; // Tradable on Pump.fun
      log.info(
        `Token ${tokenMint.slice(
          0,
          8
        )}... is on Pump.fun bonding curve (tradable)`
      );
      return result;
    }

    // Step 3: If no bonding curve, check if it's a graduated Pump.fun token
    // Check Raydium pool first
    const liquidityCheck = await checkRaydiumLiquidity(tokenMint);
    result.hasRaydiumPool = liquidityCheck.hasLiquidity;
    result.hasLiquidity = liquidityCheck.hasLiquidity;
    if (liquidityCheck.liquiditySOL !== undefined) {
      result.liquiditySOL = liquidityCheck.liquiditySOL;
    }
    if (liquidityCheck.poolAddress !== undefined) {
      result.poolAddress = liquidityCheck.poolAddress;
    }

    // Step 4: If has Raydium pool, check if it originated from Pump.fun
    if (result.hasRaydiumPool) {
      // Check transaction history to confirm Pump.fun origin
      const isFromPumpFun = await isGraduatedPumpFunToken(tokenMint);

      if (isFromPumpFun) {
        // Confirmed: graduated from Pump.fun
        result.isPumpFun = true;
        result.hasGraduated = true;

        if (result.hasLiquidity) {
          // Check if liquidity is non-zero
          if (result.liquiditySOL && result.liquiditySOL > 0) {
            result.stage = TokenLifecycleStage.FULLY_TRADABLE;
            result.isTradable = true;
            log.info(
              `Token ${tokenMint.slice(
                0,
                8
              )}... is fully graduated Pump.fun token with ${result.liquiditySOL.toFixed(
                2
              )} SOL liquidity (tradable)`
            );
          } else {
            result.stage = TokenLifecycleStage.GRADUATED_ZERO_LIQUIDITY;
            result.isTradable = false;
            result.errorMessage =
              "Graduated Pump.fun token but has zero liquidity";
            log.warn(
              `Token ${tokenMint.slice(
                0,
                8
              )}... is graduated Pump.fun but has zero liquidity (not tradable)`
            );
          }
        } else {
          result.stage = TokenLifecycleStage.GRADUATED_ZERO_LIQUIDITY;
          result.isTradable = false;
          result.errorMessage =
            "Graduated Pump.fun token but liquidity check failed";
          log.warn(
            `Token ${tokenMint.slice(
              0,
              8
            )}... is graduated Pump.fun but liquidity unknown (not tradable)`
          );
        }
      } else {
        // Has Raydium pool but not from Pump.fun
        result.isPumpFun = false;
        result.hasGraduated = false;
        result.stage = TokenLifecycleStage.UNKNOWN;
        result.isTradable = false;
        result.errorMessage = "Not a Pump.fun token (different origin)";
        log.info(
          `Token ${tokenMint.slice(
            0,
            8
          )}... has Raydium pool but is not from Pump.fun (excluded)`
        );
      }
    } else {
      // No bonding curve and no Raydium pool
      result.isPumpFun = false;
      result.hasGraduated = false;
      result.stage = TokenLifecycleStage.UNKNOWN;
      result.isTradable = false;
      result.errorMessage = "No Raydium pool found";
      log.info(`Token ${tokenMint.slice(0, 8)}... has no Raydium pool`);
    }

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(
      `Lifecycle validation failed for ${tokenMint.slice(0, 8)}...: ${errorMsg}`
    );

    result.stage = TokenLifecycleStage.UNKNOWN;
    result.isTradable = false;
    result.errorMessage = `Validation error: ${errorMsg}`;
    return result;
  }
}

/**
 * Batch validate multiple tokens and classify them
 */
export async function validateTokenBatch(tokenMints: string[]): Promise<{
  tradable: TokenLifecycleResult[];
  notTradable: TokenLifecycleResult[];
  summary: {
    total: number;
    tradableCount: number;
    pumpFunBonding: number;
    fullyGraduated: number;
    graduatedNoPool: number;
    graduatedZeroLiquidity: number;
    unknown: number;
  };
}> {
  log.info(`Batch validating ${tokenMints.length} tokens...`);

  const results = await Promise.all(
    tokenMints.map((mint) => validateTokenLifecycle(mint))
  );

  const tradable = results.filter((r) => r.isTradable);
  const notTradable = results.filter((r) => !r.isTradable);

  const summary = {
    total: results.length,
    tradableCount: tradable.length,
    pumpFunBonding: results.filter(
      (r) => r.stage === TokenLifecycleStage.PUMP_FUN_BONDING
    ).length,
    fullyGraduated: results.filter(
      (r) => r.stage === TokenLifecycleStage.FULLY_TRADABLE
    ).length,
    graduatedNoPool: results.filter(
      (r) => r.stage === TokenLifecycleStage.GRADUATED_NO_POOL
    ).length,
    graduatedZeroLiquidity: results.filter(
      (r) => r.stage === TokenLifecycleStage.GRADUATED_ZERO_LIQUIDITY
    ).length,
    unknown: results.filter((r) => r.stage === TokenLifecycleStage.UNKNOWN)
      .length,
  };

  log.info(
    `Batch validation complete: ${summary.tradableCount}/${summary.total} tradable ` +
      `(${summary.pumpFunBonding} on Pump.fun, ${summary.fullyGraduated} fully graduated, ` +
      `${summary.graduatedZeroLiquidity} zero liquidity, ${summary.unknown} unknown)`
  );

  return { tradable, notTradable, summary };
}

/**
 * Get human-readable status message for lifecycle result
 */
export function getLifecycleStatusMessage(
  result: TokenLifecycleResult
): string {
  switch (result.stage) {
    case TokenLifecycleStage.PUMP_FUN_BONDING:
      return "✅ Active on Pump.fun bonding curve - Tradable";
    case TokenLifecycleStage.FULLY_TRADABLE:
      return `✅ Graduated to Raydium with ${
        result.liquiditySOL?.toFixed(2) || "active"
      } SOL liquidity - Tradable`;
    case TokenLifecycleStage.GRADUATED_NO_POOL:
      return "⏳ Graduated from Pump.fun but Raydium pool not available yet - Not Tradable";
    case TokenLifecycleStage.GRADUATED_ZERO_LIQUIDITY:
      return "⚠️ Graduated but pool has zero liquidity - Not Tradable";
    case TokenLifecycleStage.UNKNOWN:
      return `❓ ${
        result.errorMessage || "Unable to determine token status"
      } - Not Tradable`;
    default:
      return "❓ Unknown status";
  }
}

export default {
  validateTokenLifecycle,
  validateTokenBatch,
  getLifecycleStatusMessage,
  TokenLifecycleStage,
};
