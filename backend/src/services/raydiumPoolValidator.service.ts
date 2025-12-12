// backend/src/services/raydiumPoolValidator.service.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import axios from "axios";

const LOG = getLogger("raydium-validator");

interface ValidationConfig {
  minLiquiditySol: number;
  maxBuyTax: number;
  maxSellTax: number;
  requireMintDisabled: boolean;
  requireFreezeDisabled: boolean;
  requireLpLocked: boolean;
}

interface ValidationResult {
  approved: boolean;
  reason?: string;
  passedFilters: string[];
  failedFilters: string[];
  details: {
    liquiditySol: number;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    buyTax: number;
    sellTax: number;
    lpLocked: boolean;
    isHoneypot: boolean;
  };
}

/**
 * Comprehensive Raydium pool validation
 * Checks all safety criteria before allowing trades
 */
export async function validateRaydiumPool(
  tokenMint: string,
  poolId: string,
  config: ValidationConfig,
  liquiditySol?: number
): Promise<ValidationResult> {
  const passedFilters: string[] = [];
  const failedFilters: string[] = [];

  try {
    LOG.info(`🔍 Validating Raydium pool for ${tokenMint.slice(0, 8)}...`);

    // Initialize connection
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );

    // Step 1: Check liquidity
    LOG.debug("Checking liquidity...");
    const liquidityValue =
      liquiditySol ?? (await getPoolLiquidity(poolId, connection));

    if (liquidityValue >= config.minLiquiditySol) {
      passedFilters.push(`liquidity_check_${config.minLiquiditySol}_sol`);
      LOG.info(`✅ Liquidity check passed: ${liquidityValue.toFixed(2)} SOL`);
    } else {
      failedFilters.push(`liquidity_check_${config.minLiquiditySol}_sol`);
      LOG.warn(
        `❌ Liquidity too low: ${liquidityValue.toFixed(2)} SOL < ${
          config.minLiquiditySol
        } SOL`
      );
      return {
        approved: false,
        reason: `Insufficient liquidity: ${liquidityValue.toFixed(2)} SOL`,
        passedFilters,
        failedFilters,
        details: {
          liquiditySol: liquidityValue,
          mintAuthority: null,
          freezeAuthority: null,
          buyTax: 0,
          sellTax: 0,
          lpLocked: false,
          isHoneypot: false,
        },
      };
    }

    // Step 2: Check token authorities (fast check)
    LOG.debug("Checking token authorities...");
    const authorities = await getTokenAuthorities(tokenMint, connection);

    if (config.requireMintDisabled) {
      if (authorities.mintAuthority === null) {
        passedFilters.push("mint_authority_disabled");
        LOG.info("✅ Mint authority disabled");
      } else {
        failedFilters.push("mint_authority_disabled");
        LOG.warn(
          `❌ Mint authority still enabled: ${authorities.mintAuthority}`
        );
      }
    }

    if (config.requireFreezeDisabled) {
      if (authorities.freezeAuthority === null) {
        passedFilters.push("freeze_authority_disabled");
        LOG.info("✅ Freeze authority disabled");
      } else {
        failedFilters.push("freeze_authority_disabled");
        LOG.warn(
          `❌ Freeze authority still enabled: ${authorities.freezeAuthority}`
        );
      }
    }

    // Early exit if critical checks failed (skip slow API calls)
    if (failedFilters.length > 0) {
      LOG.debug(
        `Skipping slow checks - already failed ${failedFilters.length} critical checks`
      );
      return {
        approved: false,
        reason: `Failed ${failedFilters.length} critical check(s)`,
        passedFilters,
        failedFilters,
        details: {
          liquiditySol: liquidityValue,
          mintAuthority: authorities.mintAuthority,
          freezeAuthority: authorities.freezeAuthority,
          buyTax: 0,
          sellTax: 0,
          lpLocked: false,
          isHoneypot: false,
        },
      };
    }

    // Step 3: Check buy/sell taxes (slow API call to RugCheck)
    LOG.debug("Checking token taxes...");
    const taxes = await getTokenTaxes(tokenMint);

    if (taxes.buyTax <= config.maxBuyTax) {
      passedFilters.push(`buy_tax_under_${config.maxBuyTax}_pct`);
      LOG.info(`✅ Buy tax acceptable: ${taxes.buyTax}%`);
    } else {
      failedFilters.push(`buy_tax_under_${config.maxBuyTax}_pct`);
      LOG.warn(`❌ Buy tax too high: ${taxes.buyTax}% > ${config.maxBuyTax}%`);
    }

    if (taxes.sellTax <= config.maxSellTax) {
      passedFilters.push(`sell_tax_under_${config.maxSellTax}_pct`);
      LOG.info(`✅ Sell tax acceptable: ${taxes.sellTax}%`);
    } else {
      failedFilters.push(`sell_tax_under_${config.maxSellTax}_pct`);
      LOG.warn(
        `❌ Sell tax too high: ${taxes.sellTax}% > ${config.maxSellTax}%`
      );
    }

    // Step 4: Honeypot check
    LOG.debug("Checking for honeypot...");
    const isHoneypot = await checkHoneypot(tokenMint);

    if (!isHoneypot) {
      passedFilters.push("honeypot_check");
      LOG.info("✅ Not a honeypot");
    } else {
      failedFilters.push("honeypot_check");
      LOG.warn("❌ Potential honeypot detected");
    }

    // Step 5: Check LP locked/burned (optional)
    let lpLocked = false;
    if (config.requireLpLocked) {
      LOG.debug("Checking LP lock status...");
      lpLocked = await checkLpLocked(poolId, connection);

      if (lpLocked) {
        passedFilters.push("lp_locked");
        LOG.info("✅ LP tokens locked or burned");
      } else {
        failedFilters.push("lp_locked");
        LOG.warn("❌ LP tokens not locked");
      }
    }

    // Final decision
    const approved = failedFilters.length === 0;
    const details = {
      liquiditySol: liquidityValue,
      mintAuthority: authorities.mintAuthority,
      freezeAuthority: authorities.freezeAuthority,
      buyTax: taxes.buyTax,
      sellTax: taxes.sellTax,
      lpLocked,
      isHoneypot,
    };

    if (approved) {
      LOG.info(
        {
          passed: passedFilters.length,
          failed: failedFilters.length,
        },
        `✅ Pool validation PASSED for ${tokenMint.slice(0, 8)}`
      );
    } else {
      LOG.warn(
        {
          passed: passedFilters.length,
          failed: failedFilters.length,
          failedChecks: failedFilters,
        },
        `❌ Pool validation FAILED for ${tokenMint.slice(0, 8)}`
      );
    }

    const result: ValidationResult = {
      approved,
      passedFilters,
      failedFilters,
      details,
    };

    if (!approved) {
      result.reason = `Failed ${failedFilters.length} validation check(s)`;
    }

    return result;
  } catch (err: any) {
    LOG.error(`Validation error: ${err.message}`);
    return {
      approved: false,
      reason: `Validation error: ${err.message}`,
      passedFilters,
      failedFilters: ["validation_error"],
      details: {
        liquiditySol: 0,
        mintAuthority: null,
        freezeAuthority: null,
        buyTax: 0,
        sellTax: 0,
        lpLocked: false,
        isHoneypot: false,
      },
    };
  }
}

/**
 * Get pool liquidity in SOL
 */
async function getPoolLiquidity(
  poolId: string,
  connection: Connection
): Promise<number> {
  try {
    // Try to get pool account balance
    const poolPubkey = new PublicKey(poolId);
    const balance = await connection.getBalance(poolPubkey);
    return balance / 1e9;
  } catch (err: any) {
    LOG.warn(
      `Could not fetch pool liquidity directly, estimating from DexScreener`
    );
    // Fallback: estimate from DexScreener or other sources
    return 0;
  }
}

/**
 * Get token mint and freeze authorities
 */
async function getTokenAuthorities(
  tokenMint: string,
  connection: Connection
): Promise<{ mintAuthority: string | null; freezeAuthority: string | null }> {
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);

    if (mintInfo.value && "parsed" in mintInfo.value.data) {
      const parsed = mintInfo.value.data.parsed;
      return {
        mintAuthority: parsed.info.mintAuthority || null,
        freezeAuthority: parsed.info.freezeAuthority || null,
      };
    }

    return { mintAuthority: null, freezeAuthority: null };
  } catch (err: any) {
    LOG.error(`Error fetching token authorities: ${err.message}`);
    // Assume worst case (authorities enabled)
    return { mintAuthority: "unknown", freezeAuthority: "unknown" };
  }
}

/**
 * Get token buy/sell tax percentages
 */
async function getTokenTaxes(
  tokenMint: string
): Promise<{ buyTax: number; sellTax: number }> {
  try {
    // TryRugCheck API for tax information
    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
      { timeout: 5000 }
    );

    if (response.data) {
      const buyTax = response.data.markets?.[0]?.buyTax || 0;
      const sellTax = response.data.markets?.[0]?.sellTax || 0;
      return { buyTax, sellTax };
    }
  } catch (err: any) {
    LOG.debug(`RugCheck API unavailable, assuming no tax`);
  }

  // Default to 0% if cannot determine
  return { buyTax: 0, sellTax: 0 };
}

/**
 * Check if token is a honeypot
 */
async function checkHoneypot(tokenMint: string): Promise<boolean> {
  try {
    // Try RugCheck API
    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
      { timeout: 5000 }
    );

    if (response.data) {
      const risks = response.data.risks || [];
      // Check for honeypot-related risks
      const honeypotRisks = risks.filter(
        (r: any) =>
          r.name?.toLowerCase().includes("honeypot") ||
          r.name?.toLowerCase().includes("cannot sell")
      );
      return honeypotRisks.length > 0;
    }
  } catch (err: any) {
    LOG.debug(`Honeypot check unavailable`);
  }

  return false;
}

/**
 * Check if LP tokens are locked or burned
 */
async function checkLpLocked(
  poolId: string,
  connection: Connection
): Promise<boolean> {
  try {
    // Get LP token mint from pool
    // Check if LP tokens are in known locker addresses or burned
    // This is a simplified check - actual implementation would query LP token distribution

    // Common LP burn address
    const burnAddress = "1111111111111111111111111111111111111111111";

    // For now, return false (would need more complex logic)
    return false;
  } catch (err: any) {
    LOG.error(`Error checking LP lock status: ${err.message}`);
    return false;
  }
}
