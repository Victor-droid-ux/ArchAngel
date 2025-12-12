import axios from "axios";
import { getLogger } from "../utils/logger.js";

const LOG = getLogger("birdeye.service");

interface BirdeyeHoneypotResult {
  isHoneypot: boolean;
  sellSimulationPassed: boolean;
  buyTax: number;
  sellTax: number;
  ownerPercentage: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityDisabled: boolean;
  lpLocked: boolean;
  hasBlacklist: boolean;
  hasTransferRestrictions: boolean;
  riskScore: number;
  reasons: string[];
}

interface BirdeyeMarketHealth {
  isHealthy: boolean;
  priceImpact: number;
  fdv: number;
  liquidity: number;
  volume5m: number;
  hasSoftRugged: boolean;
  hasSuspiciousSells: boolean;
  isBotActivity: boolean;
  reasons: string[];
}

interface BirdeyePnLData {
  currentPrice: number;
  priceImpact: number;
  unrealizedPnL: number;
  percentChange: number;
  liquidityMovement: number;
  trendDirection: "up" | "down" | "stable";
}

interface BirdeyeSellSimulation {
  canSell: boolean;
  priceImpact: number;
  lpStable: boolean;
  hasTransferRestrictions: boolean;
  ownerActivity: boolean;
  reasons: string[];
}

class BirdeyeService {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.BIRDEYE_API_KEY || "";
    this.baseUrl =
      process.env.BIRDEYE_BASE_URL || "https://public-api.birdeye.so";
  }

  /**
   * Stage 3: BIRDEYE HONEYPOT CHECK
   * Full safety analysis using Birdeye API
   */
  async checkHoneypot(tokenMint: string): Promise<BirdeyeHoneypotResult> {
    LOG.info(
      `🔍 Running Birdeye honeypot check for ${tokenMint.slice(0, 8)}...`
    );

    try {
      // TODO: Replace with actual Birdeye API endpoint when you provide it
      const response = await axios.get(`${this.baseUrl}/defi/token_security`, {
        params: { address: tokenMint },
        headers: {
          "X-API-KEY": this.apiKey,
        },
        timeout: 10000,
      });

      const data = response.data?.data;

      if (!data) {
        LOG.warn("⚠️ No data returned from Birdeye honeypot check");
        return {
          isHoneypot: true,
          sellSimulationPassed: false,
          buyTax: 100,
          sellTax: 100,
          ownerPercentage: 100,
          mintAuthorityRevoked: false,
          freezeAuthorityDisabled: false,
          lpLocked: false,
          hasBlacklist: true,
          hasTransferRestrictions: true,
          riskScore: 0,
          reasons: ["No data from Birdeye API"],
        };
      }

      const reasons: string[] = [];
      let isHoneypot = false;

      // Check sell simulation
      if (!data.sellSimulation || data.sellSimulation.failed) {
        reasons.push("Sell simulation failed");
        isHoneypot = true;
      }

      // Check taxes
      const buyTax = data.buyTax || 0;
      const sellTax = data.sellTax || 0;
      if (sellTax > buyTax * 3) {
        reasons.push(`Sell tax (${sellTax}%) > Buy tax (${buyTax}%) * 3`);
        isHoneypot = true;
      }

      // Check owner percentage
      const ownerPercentage = data.ownerBalance || 0;
      if (ownerPercentage > 20) {
        reasons.push(`Owner controls ${ownerPercentage}% of supply`);
        isHoneypot = true;
      }

      // Check mint authority
      if (!data.mintAuthorityRevoked) {
        reasons.push("Mint authority still active");
        isHoneypot = true;
      }

      // Check freeze authority
      if (data.freezeAuthority) {
        reasons.push("Freeze authority active");
        isHoneypot = true;
      }

      // Check LP lock
      if (!data.lpLocked && !data.lpBurnt) {
        reasons.push("LP not locked or burnt");
        isHoneypot = true;
      }

      // Check blacklist
      if (data.hasBlacklist) {
        reasons.push("Token has blacklist logic");
        isHoneypot = true;
      }

      // Check transfer restrictions
      if (data.hasTransferRestrictions) {
        reasons.push("Token has transfer restrictions");
        isHoneypot = true;
      }

      // Check risk score
      const riskScore = data.riskScore || 0;
      if (riskScore < 60) {
        reasons.push(`Low risk score: ${riskScore}`);
        isHoneypot = true;
      }

      if (!isHoneypot) {
        LOG.info(`✅ Honeypot check PASSED for ${tokenMint.slice(0, 8)}`);
      } else {
        LOG.warn(
          `❌ Honeypot check FAILED for ${tokenMint.slice(
            0,
            8
          )}: ${reasons.join(", ")}`
        );
      }

      return {
        isHoneypot,
        sellSimulationPassed: !data.sellSimulation?.failed,
        buyTax,
        sellTax,
        ownerPercentage,
        mintAuthorityRevoked: data.mintAuthorityRevoked || false,
        freezeAuthorityDisabled: !data.freezeAuthority,
        lpLocked: data.lpLocked || data.lpBurnt || false,
        hasBlacklist: data.hasBlacklist || false,
        hasTransferRestrictions: data.hasTransferRestrictions || false,
        riskScore,
        reasons,
      };
    } catch (error: any) {
      LOG.error(`Error checking honeypot: ${error.message}`);
      return {
        isHoneypot: true,
        sellSimulationPassed: false,
        buyTax: 100,
        sellTax: 100,
        ownerPercentage: 100,
        mintAuthorityRevoked: false,
        freezeAuthorityDisabled: false,
        lpLocked: false,
        hasBlacklist: true,
        hasTransferRestrictions: true,
        riskScore: 0,
        reasons: [`API Error: ${error.message}`],
      };
    }
  }

  /**
   * Stage 4: BIRDEYE MARKET HEALTH CHECK
   * Ensure token is tradeable and worth entering
   */
  async checkMarketHealth(
    tokenMint: string,
    buyAmountSol: number
  ): Promise<BirdeyeMarketHealth> {
    LOG.info(
      `📊 Running Birdeye market health check for ${tokenMint.slice(0, 8)}...`
    );

    try {
      // TODO: Replace with actual Birdeye API endpoint when you provide it
      const response = await axios.get(`${this.baseUrl}/defi/token_overview`, {
        params: { address: tokenMint },
        headers: {
          "X-API-KEY": this.apiKey,
        },
        timeout: 10000,
      });

      const data = response.data?.data;

      if (!data) {
        LOG.warn("⚠️ No data returned from Birdeye market health check");
        return {
          isHealthy: false,
          priceImpact: 100,
          fdv: 0,
          liquidity: 0,
          volume5m: 0,
          hasSoftRugged: false,
          hasSuspiciousSells: false,
          isBotActivity: false,
          reasons: ["No data from Birdeye API"],
        };
      }

      const reasons: string[] = [];
      let isHealthy = true;

      // Calculate price impact for buy size
      const priceImpact = this.calculatePriceImpact(
        data.liquidity,
        buyAmountSol
      );
      if (priceImpact > 30) {
        reasons.push(`Price impact too high: ${priceImpact.toFixed(2)}%`);
        isHealthy = false;
      }

      // Check FDV vs LP ratio
      const fdv = data.fdv || 0;
      const liquidity = data.liquidity || 0;
      if (fdv > 3000000 && liquidity < 2) {
        reasons.push(`FDV ${fdv} too high for LP ${liquidity} SOL`);
        isHealthy = false;
      }

      // Check volume
      const volume5m = data.volume5m || 0;
      if (volume5m < 1) {
        reasons.push(`Volume too low: ${volume5m} SOL in last 5 minutes`);
        isHealthy = false;
      }

      // Check for soft rug
      const hasSoftRugged = this.detectSoftRug(data);
      if (hasSoftRugged) {
        reasons.push("Soft rug detected");
        isHealthy = false;
      }

      // Check for suspicious sells
      const hasSuspiciousSells = this.detectSuspiciousSells(data);
      if (hasSuspiciousSells) {
        reasons.push("Suspicious massive sells detected");
        isHealthy = false;
      }

      // Check for bot activity
      const isBotActivity = this.detectBotActivity(data);
      if (isBotActivity) {
        reasons.push("Bot-only wash trading detected");
        isHealthy = false;
      }

      if (isHealthy) {
        LOG.info(`✅ Market health check PASSED for ${tokenMint.slice(0, 8)}`);
      } else {
        LOG.warn(
          `❌ Market health check FAILED for ${tokenMint.slice(
            0,
            8
          )}: ${reasons.join(", ")}`
        );
      }

      return {
        isHealthy,
        priceImpact,
        fdv,
        liquidity,
        volume5m,
        hasSoftRugged,
        hasSuspiciousSells,
        isBotActivity,
        reasons,
      };
    } catch (error: any) {
      LOG.error(`Error checking market health: ${error.message}`);
      return {
        isHealthy: false,
        priceImpact: 100,
        fdv: 0,
        liquidity: 0,
        volume5m: 0,
        hasSoftRugged: false,
        hasSuspiciousSells: false,
        isBotActivity: false,
        reasons: [`API Error: ${error.message}`],
      };
    }
  }

  /**
   * Stage 7: LIVE P&L TRACKING
   * Pull real-time data from Birdeye
   */
  async getPnLData(
    tokenMint: string,
    entryPrice: number
  ): Promise<BirdeyePnLData> {
    try {
      // TODO: Replace with actual Birdeye API endpoint when you provide it
      const response = await axios.get(`${this.baseUrl}/defi/price`, {
        params: { address: tokenMint },
        headers: {
          "X-API-KEY": this.apiKey,
        },
        timeout: 5000,
      });

      const data = response.data?.data;

      if (!data) {
        throw new Error("No price data from Birdeye");
      }

      const currentPrice = data.value || 0;
      const percentChange = ((currentPrice - entryPrice) / entryPrice) * 100;
      const unrealizedPnL = currentPrice - entryPrice;

      let trendDirection: "up" | "down" | "stable" = "stable";
      if (percentChange > 2) trendDirection = "up";
      else if (percentChange < -2) trendDirection = "down";

      return {
        currentPrice,
        priceImpact: data.priceImpact || 0,
        unrealizedPnL,
        percentChange,
        liquidityMovement: data.liquidityChange || 0,
        trendDirection,
      };
    } catch (error: any) {
      LOG.error(`Error getting P&L data: ${error.message}`);
      return {
        currentPrice: entryPrice,
        priceImpact: 0,
        unrealizedPnL: 0,
        percentChange: 0,
        liquidityMovement: 0,
        trendDirection: "stable",
      };
    }
  }

  /**
   * Stage 8: PRE-SELL VALIDATION
   * Validate sell before executing
   */
  async validateSell(
    tokenMint: string,
    sellAmountSol: number
  ): Promise<BirdeyeSellSimulation> {
    LOG.info(`🔍 Running pre-sell validation for ${tokenMint.slice(0, 8)}...`);

    try {
      // TODO: Replace with actual Birdeye API endpoint when you provide it
      const response = await axios.post(
        `${this.baseUrl}/defi/simulate_sell`,
        {
          address: tokenMint,
          amount: sellAmountSol,
        },
        {
          headers: {
            "X-API-KEY": this.apiKey,
          },
          timeout: 10000,
        }
      );

      const data = response.data?.data;

      if (!data) {
        LOG.warn("⚠️ No data returned from Birdeye sell simulation");
        return {
          canSell: false,
          priceImpact: 100,
          lpStable: false,
          hasTransferRestrictions: true,
          ownerActivity: true,
          reasons: ["No data from Birdeye API"],
        };
      }

      const reasons: string[] = [];
      let canSell = true;

      // Check if simulation passed
      if (data.failed) {
        reasons.push("Sell simulation failed");
        canSell = false;
      }

      // Check price impact
      const priceImpact = data.priceImpact || 0;
      if (priceImpact > 40) {
        reasons.push(`Price impact too high: ${priceImpact.toFixed(2)}%`);
        canSell = false;
      }

      // Check LP stability
      if (data.lpRugged) {
        reasons.push("LP has rugged");
        canSell = false;
      }

      // Check transfer restrictions
      if (data.hasTransferRestrictions) {
        reasons.push("Transfer restrictions detected");
        canSell = false;
      }

      // Check owner activity
      if (data.suspiciousOwnerActivity) {
        reasons.push("Suspicious owner transactions detected");
        canSell = false;
      }

      if (canSell) {
        LOG.info(`✅ Pre-sell validation PASSED for ${tokenMint.slice(0, 8)}`);
      } else {
        LOG.warn(
          `❌ Pre-sell validation FAILED for ${tokenMint.slice(
            0,
            8
          )}: ${reasons.join(", ")}`
        );
      }

      return {
        canSell,
        priceImpact,
        lpStable: !data.lpRugged,
        hasTransferRestrictions: data.hasTransferRestrictions || false,
        ownerActivity: data.suspiciousOwnerActivity || false,
        reasons,
      };
    } catch (error: any) {
      LOG.error(`Error validating sell: ${error.message}`);
      return {
        canSell: false,
        priceImpact: 100,
        lpStable: false,
        hasTransferRestrictions: true,
        ownerActivity: true,
        reasons: [`API Error: ${error.message}`],
      };
    }
  }

  // Helper methods
  private calculatePriceImpact(liquidity: number, tradeSize: number): number {
    if (liquidity === 0) return 100;
    return (tradeSize / liquidity) * 100;
  }

  private detectSoftRug(data: any): boolean {
    // Implement soft rug detection logic based on Birdeye data
    // Look for sudden LP removal, large sells from creator, etc.
    return false; // Placeholder
  }

  private detectSuspiciousSells(data: any): boolean {
    // Implement suspicious sell detection
    // Look for massive sells, coordinated dumps, etc.
    return false; // Placeholder
  }

  private detectBotActivity(data: any): boolean {
    // Implement bot activity detection
    // Look for same wallet buying/selling, no real volume, etc.
    return false; // Placeholder
  }
}

export default new BirdeyeService();
export {
  BirdeyeHoneypotResult,
  BirdeyeMarketHealth,
  BirdeyePnLData,
  BirdeyeSellSimulation,
};
