import axios from "axios";
import { getLogger } from "../utils/logger.js";

const LOG = getLogger("flux.service");

interface FluxPreExecutionResult {
  canExecute: boolean;
  routeAvailable: boolean;
  priorityFees: number;
  hasSufficientBalance: boolean;
  gasEstimate: number;
  slippageAcceptable: boolean;
  simulationPassed: boolean;
  reasons: string[];
}

interface FluxExecutionResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  actualPrice?: number;
  error?: string;
}

interface FluxBuyParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippage: number;
  userPublicKey: string;
}

interface FluxSellParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippage: number;
  userPublicKey: string;
}

class FluxService {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.FLUX_API_KEY || "";
    this.baseUrl = process.env.FLUX_BASE_URL || "https://api.fluxbeam.xyz";
  }

  /**
   * Stage 5: FLUX PRE-EXECUTION CHECK
   * Ensure Flux can execute the trade without failure
   */
  async preExecutionCheck(
    params: FluxBuyParams
  ): Promise<FluxPreExecutionResult> {
    LOG.info(
      `🔍 Running Flux pre-execution check for ${params.outputMint.slice(
        0,
        8
      )}...`
    );

    try {
      // TODO: Replace with actual Flux API endpoint when you provide it
      const response = await axios.post(
        `${this.baseUrl}/v1/swap/quote`,
        {
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          amount: params.amount,
          slippageBps: Math.round(params.slippage * 100),
          userPublicKey: params.userPublicKey,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          timeout: 10000,
        }
      );

      const data = response.data;

      if (!data) {
        LOG.warn("⚠️ No data returned from Flux pre-execution check");
        return {
          canExecute: false,
          routeAvailable: false,
          priorityFees: 0,
          hasSufficientBalance: false,
          gasEstimate: 0,
          slippageAcceptable: false,
          simulationPassed: false,
          reasons: ["No data from Flux API"],
        };
      }

      const reasons: string[] = [];
      let canExecute = true;

      // Check if route is available
      if (
        !data.route ||
        !data.route.marketInfos ||
        data.route.marketInfos.length === 0
      ) {
        reasons.push("No Flux route available");
        canExecute = false;
      }

      // Check priority fees
      const priorityFees = data.priorityFee || 0;
      if (priorityFees === 0) {
        reasons.push("Priority fees not calculated");
        canExecute = false;
      }

      // Check wallet balance
      const hasSufficientBalance = data.hasSufficientBalance !== false;
      if (!hasSufficientBalance) {
        reasons.push("Insufficient wallet balance");
        canExecute = false;
      }

      // Check gas estimate
      const gasEstimate = data.gasEstimate || 0;
      if (gasEstimate === 0) {
        reasons.push("Gas estimate unavailable");
        canExecute = false;
      }

      // Check slippage
      const estimatedSlippage = data.estimatedSlippage || 0;
      const slippageAcceptable = estimatedSlippage <= params.slippage;
      if (!slippageAcceptable) {
        reasons.push(
          `Slippage too high: ${estimatedSlippage}% > ${params.slippage}%`
        );
        canExecute = false;
      }

      // Check simulation
      const simulationPassed = !data.simulationError && !data.preflightFailed;
      if (!simulationPassed) {
        reasons.push("Flux simulation failed");
        canExecute = false;
      }

      if (canExecute) {
        LOG.info(
          `✅ Flux pre-execution check PASSED for ${params.outputMint.slice(
            0,
            8
          )}`
        );
      } else {
        LOG.warn(
          `❌ Flux pre-execution check FAILED for ${params.outputMint.slice(
            0,
            8
          )}: ${reasons.join(", ")}`
        );
      }

      return {
        canExecute,
        routeAvailable: !!data.route,
        priorityFees,
        hasSufficientBalance,
        gasEstimate,
        slippageAcceptable,
        simulationPassed,
        reasons,
      };
    } catch (error: any) {
      LOG.error(`Error in Flux pre-execution check: ${error.message}`);
      return {
        canExecute: false,
        routeAvailable: false,
        priorityFees: 0,
        hasSufficientBalance: false,
        gasEstimate: 0,
        slippageAcceptable: false,
        simulationPassed: false,
        reasons: [`API Error: ${error.message}`],
      };
    }
  }

  /**
   * Stage 6: FLUX EXECUTION (BUY)
   * Execute the buy instantly with no reverts
   */
  async executeBuy(params: FluxBuyParams): Promise<FluxExecutionResult> {
    LOG.info(`🚀 Executing Flux BUY for ${params.outputMint.slice(0, 8)}...`);

    try {
      // TODO: Replace with actual Flux API endpoint when you provide it
      const response = await axios.post(
        `${this.baseUrl}/v1/swap/execute`,
        {
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          amount: params.amount,
          slippageBps: Math.round(params.slippage * 100),
          userPublicKey: params.userPublicKey,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          timeout: 30000,
        }
      );

      const data = response.data;

      if (!data || !data.signature) {
        LOG.error("❌ Flux buy execution failed: No signature returned");
        return {
          success: false,
          error: "No signature returned from Flux",
        };
      }

      LOG.info(`✅ Flux BUY executed successfully: ${data.signature}`);

      return {
        success: true,
        signature: data.signature,
        tokensReceived: data.outputAmount || 0,
        actualPrice: data.executionPrice || 0,
      };
    } catch (error: any) {
      LOG.error(`❌ Error executing Flux buy: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Stage 8: FLUX EXECUTION (SELL)
   * Execute the sell after validation
   */
  async executeSell(params: FluxSellParams): Promise<FluxExecutionResult> {
    LOG.info(`🚀 Executing Flux SELL for ${params.inputMint.slice(0, 8)}...`);

    try {
      // TODO: Replace with actual Flux API endpoint when you provide it
      const response = await axios.post(
        `${this.baseUrl}/v1/swap/execute`,
        {
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          amount: params.amount,
          slippageBps: Math.round(params.slippage * 100),
          userPublicKey: params.userPublicKey,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          timeout: 30000,
        }
      );

      const data = response.data;

      if (!data || !data.signature) {
        LOG.error("❌ Flux sell execution failed: No signature returned");
        return {
          success: false,
          error: "No signature returned from Flux",
        };
      }

      LOG.info(`✅ Flux SELL executed successfully: ${data.signature}`);

      return {
        success: true,
        signature: data.signature,
        tokensReceived: data.outputAmount || 0,
        actualPrice: data.executionPrice || 0,
      };
    } catch (error: any) {
      LOG.error(`❌ Error executing Flux sell: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Validate token balance after buy
   */
  async validateBalanceIncrease(
    userPublicKey: string,
    tokenMint: string,
    expectedAmount: number
  ): Promise<boolean> {
    try {
      // TODO: Implement actual balance check using Solana connection
      LOG.info(`Validating balance increase for ${tokenMint.slice(0, 8)}...`);

      // Placeholder - implement actual balance check
      return true;
    } catch (error: any) {
      LOG.error(`Error validating balance: ${error.message}`);
      return false;
    }
  }
}

export default new FluxService();
export {
  FluxPreExecutionResult,
  FluxExecutionResult,
  FluxBuyParams,
  FluxSellParams,
};
