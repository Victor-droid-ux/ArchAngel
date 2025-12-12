import { getLogger } from "../utils/logger.js";
import { getRaydiumQuote } from "./raydium.service.js";
import birdeyeService, {
  BirdeyeHoneypotResult,
  BirdeyeMarketHealth,
} from "./birdeye.service.js";
import fluxService, {
  FluxPreExecutionResult,
  FluxExecutionResult,
} from "./flux.service.js";
import dbService from "./db.service.js";

const LOG = getLogger("validation-pipeline");
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface ValidationResult {
  passed: boolean;
  stage: number;
  stageName: string;
  reason?: string;
  details?: any;
}

interface PipelineResult {
  success: boolean;
  failedStage?: number;
  failedStageName?: string;
  reason?: string;
  results: ValidationResult[];
  executionResult?: FluxExecutionResult;
}

interface PoolValidation {
  poolExists: boolean;
  lpSufficient: boolean;
  lpAmount: number;
  poolStable: boolean;
}

interface RoutingTestResult {
  buyRoutePasses: boolean;
  sellRoutePasses: boolean;
  slippageAcceptable: boolean;
  bidirectionalTrading: boolean;
}

class ValidationPipelineService {
  private readonly MIN_LP_SOL = parseFloat(
    process.env.MIN_RAYDIUM_LP_SOL || "0.5"
  );
  private readonly MAX_SLIPPAGE = 49;
  private readonly AUTO_BUY_AMOUNT = parseFloat(
    process.env.AUTO_BUY_AMOUNT || "0.05"
  );
  private readonly AUTO_BUY_SLIPPAGE = parseFloat(
    process.env.AUTO_BUY_SLIPPAGE_PCT || "10"
  );

  /**
   * Run the complete 8-stage validation pipeline
   */
  async runPipeline(tokenMint: string, lpSol: number): Promise<PipelineResult> {
    LOG.info(
      `🚀 Starting 8-stage validation pipeline for ${tokenMint.slice(0, 8)}...`
    );

    const results: ValidationResult[] = [];

    // Stage 1: RAYDIUM DISCOVERY
    const stage1 = await this.stage1_raydiumDiscovery(tokenMint, lpSol);
    results.push(stage1);
    if (!stage1.passed) {
      await this.logFailure(
        tokenMint,
        1,
        "Raydium Discovery",
        stage1.reason || "Unknown"
      );
      return this.buildFailureResult(
        1,
        "Raydium Discovery",
        stage1.reason,
        results
      );
    }

    // Stage 2: RAYDIUM ROUTING TEST
    const stage2 = await this.stage2_raydiumRoutingTest(tokenMint);
    results.push(stage2);
    if (!stage2.passed) {
      await this.logFailure(
        tokenMint,
        2,
        "Raydium Routing Test",
        stage2.reason || "Unknown"
      );
      return this.buildFailureResult(
        2,
        "Raydium Routing Test",
        stage2.reason,
        results
      );
    }

    // Stage 3: BIRDEYE HONEYPOT CHECK
    const stage3 = await this.stage3_birdeyeHoneypotCheck(tokenMint);
    results.push(stage3);
    if (!stage3.passed) {
      await this.logFailure(
        tokenMint,
        3,
        "Birdeye Honeypot Check",
        stage3.reason || "Unknown"
      );
      return this.buildFailureResult(
        3,
        "Birdeye Honeypot Check",
        stage3.reason,
        results
      );
    }

    // Stage 4: BIRDEYE MARKET HEALTH CHECK
    const stage4 = await this.stage4_birdeyeMarketHealth(tokenMint);
    results.push(stage4);
    if (!stage4.passed) {
      await this.logFailure(
        tokenMint,
        4,
        "Birdeye Market Health",
        stage4.reason || "Unknown"
      );
      return this.buildFailureResult(
        4,
        "Birdeye Market Health",
        stage4.reason,
        results
      );
    }

    // Stage 5: FLUX PRE-EXECUTION CHECK
    const stage5 = await this.stage5_fluxPreExecution(tokenMint);
    results.push(stage5);
    if (!stage5.passed) {
      await this.logFailure(
        tokenMint,
        5,
        "Flux Pre-Execution",
        stage5.reason || "Unknown"
      );
      return this.buildFailureResult(
        5,
        "Flux Pre-Execution",
        stage5.reason,
        results
      );
    }

    // Stage 6: FLUX EXECUTION (BUY)
    const stage6 = await this.stage6_fluxBuy(tokenMint);
    results.push(stage6);
    if (!stage6.passed) {
      await this.logFailure(
        tokenMint,
        6,
        "Flux Buy Execution",
        stage6.reason || "Unknown"
      );
      return this.buildFailureResult(
        6,
        "Flux Buy Execution",
        stage6.reason,
        results
      );
    }

    LOG.info(`✅ All 6 execution stages PASSED for ${tokenMint.slice(0, 8)}`);

    return {
      success: true,
      results,
      executionResult: stage6.details?.executionResult,
    };
  }

  /**
   * STAGE 1: RAYDIUM DISCOVERY
   * Only detect tokens that truly exist AND have actual LP
   */
  private async stage1_raydiumDiscovery(
    tokenMint: string,
    lpSol: number
  ): Promise<ValidationResult> {
    LOG.info(`[Stage 1] 🔍 Raydium Discovery for ${tokenMint.slice(0, 8)}...`);

    try {
      // Pool existence is already confirmed by pool listener
      // Just validate LP amount here

      // Check LP amount
      if (lpSol < this.MIN_LP_SOL) {
        return {
          passed: false,
          stage: 1,
          stageName: "Raydium Discovery",
          reason: `Insufficient LP: ${lpSol} SOL < ${this.MIN_LP_SOL} SOL`,
        };
      }

      // Check if it's a fake placeholder pool (LP = 0)
      if (lpSol === 0) {
        return {
          passed: false,
          stage: 1,
          stageName: "Raydium Discovery",
          reason: "Pool LP is exactly 0 (fake pool)",
        };
      }

      LOG.info(`[Stage 1] ✅ Raydium Discovery PASSED (LP: ${lpSol} SOL)`);
      return {
        passed: true,
        stage: 1,
        stageName: "Raydium Discovery",
        details: { lpSol },
      };
    } catch (error: any) {
      LOG.error(`[Stage 1] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 1,
        stageName: "Raydium Discovery",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 2: RAYDIUM ROUTING TEST
   * Make sure Raydium can actually perform swaps
   */
  private async stage2_raydiumRoutingTest(
    tokenMint: string
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 2] 🔍 Raydium Routing Test for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const testAmount = 10000000; // 0.01 SOL for testing

      // Test BUY route
      const buyQuote = await getRaydiumQuote(
        SOL_MINT,
        tokenMint,
        testAmount,
        this.AUTO_BUY_SLIPPAGE
      );

      if (!buyQuote || !buyQuote.outAmount) {
        return {
          passed: false,
          stage: 2,
          stageName: "Raydium Routing Test",
          reason: "Buy route not available",
        };
      }

      // Test SELL route (simulate selling the tokens we would buy)
      const sellQuote = await getRaydiumQuote(
        tokenMint,
        SOL_MINT,
        Number(buyQuote.outAmount),
        this.AUTO_BUY_SLIPPAGE
      );

      if (!sellQuote || !sellQuote.outAmount) {
        return {
          passed: false,
          stage: 2,
          stageName: "Raydium Routing Test",
          reason: "Sell route not available (potential honeypot)",
        };
      }

      // Check if slippage is acceptable
      const buySlippage = this.calculateSlippage(
        testAmount,
        Number(buyQuote.outAmount)
      );
      const sellSlippage = this.calculateSlippage(
        Number(buyQuote.outAmount),
        Number(sellQuote.outAmount)
      );

      if (buySlippage > this.MAX_SLIPPAGE || sellSlippage > this.MAX_SLIPPAGE) {
        return {
          passed: false,
          stage: 2,
          stageName: "Raydium Routing Test",
          reason: `Slippage too high (buy: ${buySlippage}%, sell: ${sellSlippage}%)`,
        };
      }

      LOG.info(
        `[Stage 2] ✅ Raydium Routing Test PASSED (bidirectional trading works)`
      );
      return {
        passed: true,
        stage: 2,
        stageName: "Raydium Routing Test",
        details: { buyQuote, sellQuote, buySlippage, sellSlippage },
      };
    } catch (error: any) {
      LOG.error(`[Stage 2] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 2,
        stageName: "Raydium Routing Test",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 3: BIRDEYE HONEYPOT CHECK
   * Full safety analysis using Birdeye
   */
  private async stage3_birdeyeHoneypotCheck(
    tokenMint: string
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 3] 🔍 Birdeye Honeypot Check for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const honeypotResult = await birdeyeService.checkHoneypot(tokenMint);

      if (honeypotResult.isHoneypot) {
        return {
          passed: false,
          stage: 3,
          stageName: "Birdeye Honeypot Check",
          reason: honeypotResult.reasons.join(", "),
          details: honeypotResult,
        };
      }

      LOG.info(`[Stage 3] ✅ Birdeye Honeypot Check PASSED`);
      return {
        passed: true,
        stage: 3,
        stageName: "Birdeye Honeypot Check",
        details: honeypotResult,
      };
    } catch (error: any) {
      LOG.error(`[Stage 3] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 3,
        stageName: "Birdeye Honeypot Check",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 4: BIRDEYE MARKET HEALTH CHECK
   * Ensure token is tradeable and worth entering
   */
  private async stage4_birdeyeMarketHealth(
    tokenMint: string
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 4] 🔍 Birdeye Market Health for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const healthResult = await birdeyeService.checkMarketHealth(
        tokenMint,
        this.AUTO_BUY_AMOUNT
      );

      if (!healthResult.isHealthy) {
        return {
          passed: false,
          stage: 4,
          stageName: "Birdeye Market Health",
          reason: healthResult.reasons.join(", "),
          details: healthResult,
        };
      }

      LOG.info(`[Stage 4] ✅ Birdeye Market Health PASSED`);
      return {
        passed: true,
        stage: 4,
        stageName: "Birdeye Market Health",
        details: healthResult,
      };
    } catch (error: any) {
      LOG.error(`[Stage 4] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 4,
        stageName: "Birdeye Market Health",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 5: FLUX PRE-EXECUTION CHECK
   * Make sure Flux can execute the trade without failure
   */
  private async stage5_fluxPreExecution(
    tokenMint: string
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 5] 🔍 Flux Pre-Execution Check for ${tokenMint.slice(0, 8)}...`
    );

    try {
      const lamports = Math.floor(this.AUTO_BUY_AMOUNT * 1e9);
      const wallet = process.env.WALLET_PUBLIC_KEY || "";

      const preCheckResult = await fluxService.preExecutionCheck({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: lamports,
        slippage: this.AUTO_BUY_SLIPPAGE,
        userPublicKey: wallet,
      });

      if (!preCheckResult.canExecute) {
        return {
          passed: false,
          stage: 5,
          stageName: "Flux Pre-Execution",
          reason: preCheckResult.reasons.join(", "),
          details: preCheckResult,
        };
      }

      LOG.info(`[Stage 5] ✅ Flux Pre-Execution Check PASSED`);
      return {
        passed: true,
        stage: 5,
        stageName: "Flux Pre-Execution",
        details: preCheckResult,
      };
    } catch (error: any) {
      LOG.error(`[Stage 5] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 5,
        stageName: "Flux Pre-Execution",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 6: FLUX EXECUTION (BUY)
   * Execute the buy instantly with no reverts
   */
  private async stage6_fluxBuy(tokenMint: string): Promise<ValidationResult> {
    LOG.info(`[Stage 6] 🚀 Flux Buy Execution for ${tokenMint.slice(0, 8)}...`);

    try {
      const lamports = Math.floor(this.AUTO_BUY_AMOUNT * 1e9);
      const wallet = process.env.WALLET_PUBLIC_KEY || "";

      const executionResult = await fluxService.executeBuy({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: lamports,
        slippage: this.AUTO_BUY_SLIPPAGE,
        userPublicKey: wallet,
      });

      if (!executionResult.success) {
        return {
          passed: false,
          stage: 6,
          stageName: "Flux Buy Execution",
          reason: executionResult.error || "Execution failed",
          details: executionResult,
        };
      }

      // Validate balance increase
      const balanceValidated = await fluxService.validateBalanceIncrease(
        wallet,
        tokenMint,
        executionResult.tokensReceived || 0
      );

      if (!balanceValidated) {
        LOG.warn(`⚠️ Balance validation failed for ${tokenMint.slice(0, 8)}`);
      }

      // Store trade in database
      await dbService.addTrade({
        type: "buy",
        token: tokenMint,
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: lamports,
        price: executionResult.actualPrice || 0,
        pnl: 0,
        wallet,
        simulated: false,
        signature: executionResult.signature || "",
        route: "raydium",
      });

      LOG.info(
        `[Stage 6] ✅ Flux Buy Execution PASSED (${executionResult.signature})`
      );
      return {
        passed: true,
        stage: 6,
        stageName: "Flux Buy Execution",
        details: { executionResult, balanceValidated },
      };
    } catch (error: any) {
      LOG.error(`[Stage 6] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 6,
        stageName: "Flux Buy Execution",
        reason: `Error: ${error.message}`,
      };
    }
  }

  // Helper methods
  private calculateSlippage(expected: number, actual: number): number {
    return Math.abs(((expected - actual) / expected) * 100);
  }

  private buildFailureResult(
    stage: number,
    stageName: string,
    reason: string | undefined,
    results: ValidationResult[]
  ): PipelineResult {
    return {
      success: false,
      failedStage: stage,
      failedStageName: stageName,
      reason: reason || "Unknown error",
      results,
    };
  }

  private async logFailure(
    tokenMint: string,
    stage: number,
    stageName: string,
    reason: string
  ): Promise<void> {
    try {
      // TODO: Store in database for analysis
      LOG.warn(
        `❌ Token ${tokenMint.slice(
          0,
          8
        )} FAILED at Stage ${stage} (${stageName}): ${reason}`
      );
    } catch (error: any) {
      LOG.error(`Error logging failure: ${error.message}`);
    }
  }
}

export default new ValidationPipelineService();
export { ValidationResult, PipelineResult };
