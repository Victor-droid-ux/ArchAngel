// backend/src/services/raydiumPoolListener.service.ts
import { Connection, PublicKey, ParsedInstruction } from "@solana/web3.js";
import { Server as SocketIOServer } from "socket.io";
import { getLogger } from "../utils/logger.js";
import { validateRaydiumPool } from "./raydiumPoolValidator.service.js";
import { executeManualBuy } from "./manualBuy.service.js";
import { addTrackedToken } from "./tokenPrice.service.js";
import dbService from "./db.service.js";
import validationPipelineService from "./validationPipeline.service.js";
import pnlTrackerService from "./pnlTracker.service.js";

const LOG = getLogger("raydium-pool-listener");

// Raydium Program IDs
const RAYDIUM_LIQUIDITY_POOL_V4 =
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

interface PoolDetectionConfig {
  minLiquiditySol: number; // Minimum LP size (e.g., 20-50 SOL)
  maxBuyTax: number; // Maximum buy tax % (e.g., 5)
  maxSellTax: number; // Maximum sell tax % (e.g., 5)
  requireMintDisabled: boolean; // Must have mint authority disabled
  requireFreezeDisabled: boolean; // Must have freeze authority disabled
  requireLpLocked: boolean; // Prefer locked/burned LP
  autoBuyEnabled: boolean; // Auto-execute buy when pool passes filters
  autoBuyAmountSol: number; // Amount to buy in SOL
}

class RaydiumPoolListener {
  private connection: Connection;
  private config: PoolDetectionConfig;
  private detectedPools: Set<string> = new Set();
  private isListening: boolean = false;
  private subscriptionId: number | null = null;
  private io: SocketIOServer | null = null;
  private poolQueue: Array<{
    signature: string;
    slot: number;
    timestamp: number;
  }> = [];
  private isProcessing: boolean = false;
  private readonly MAX_QUEUE_SIZE = 200; // Increased to handle burst
  private readonly PROCESS_INTERVAL_MS = 500; // Ultra-fast: 0.5 seconds
  private readonly CONCURRENT_VALIDATIONS = 5; // Process 5 pools in parallel
  private activeValidations = 0;

  constructor() {
    const connectionConfig: any = {
      commitment: "confirmed",
    };
    if (process.env.WS_RPC_URL) {
      connectionConfig.wsEndpoint = process.env.WS_RPC_URL;
    }
    this.connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      connectionConfig
    );

    // Load configuration from environment
    this.config = {
      minLiquiditySol: Number(process.env.MIN_RAYDIUM_LP_SOL || 20),
      maxBuyTax: Number(process.env.MAX_BUY_TAX_PCT || 5),
      maxSellTax: Number(process.env.MAX_SELL_TAX_PCT || 5),
      requireMintDisabled: process.env.REQUIRE_MINT_DISABLED !== "false",
      requireFreezeDisabled: process.env.REQUIRE_FREEZE_DISABLED !== "false",
      requireLpLocked: process.env.REQUIRE_LP_LOCKED === "true",
      autoBuyEnabled: process.env.RAYDIUM_AUTO_BUY === "true",
      autoBuyAmountSol: Number(process.env.RAYDIUM_AUTO_BUY_SOL || 0.1),
    };

    LOG.info(
      {
        minLP: this.config.minLiquiditySol,
        autoBuy: this.config.autoBuyEnabled,
      },
      "Raydium Pool Listener initialized"
    );
  }

  /**
   * Set Socket.IO server for real-time events
   */
  setSocketIO(io: SocketIOServer) {
    this.io = io;
    LOG.info("Socket.IO connected to Raydium listener");
  }

  /**
   * Retry RPC calls with exponential backoff
   */
  private async retryRpcCall<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        const is429 =
          err.message?.includes("429") || err.message?.includes("Too many");

        if (i === maxRetries - 1 || !is429) {
          throw err; // Last retry or non-429 error
        }

        const delay = baseDelay * Math.pow(2, i);
        LOG.debug({ attempt: i + 1, delay }, "RPC rate limit, retrying...");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Max retries exceeded");
  }

  /**
   * Start listening for new Raydium pool creations
   */
  async startListening() {
    if (this.isListening) {
      LOG.warn("Pool listener already running");
      return;
    }

    try {
      const raydiumProgramId = new PublicKey(RAYDIUM_LIQUIDITY_POOL_V4);

      LOG.info("🎧 Starting Raydium pool listener...");

      // Subscribe to Raydium program logs
      this.subscriptionId = this.connection.onLogs(
        raydiumProgramId,
        async (logs, context) => {
          try {
            // Check for pool initialization
            const initializeLog = logs.logs.find(
              (log) =>
                log.includes("initialize") ||
                log.includes("Initialize") ||
                log.includes("initializePool") ||
                log.includes("createPool")
            );

            if (initializeLog && logs.signature) {
              LOG.info(`🆕 New Raydium pool detected: ${logs.signature}`);
              this.queuePool(logs.signature, context.slot);
            }
          } catch (err: any) {
            LOG.error(`Error processing pool log: ${err.message}`);
          }
        },
        "confirmed"
      );

      this.isListening = true;
      this.startQueueProcessor();
      LOG.info(
        `✅ Raydium pool listener active (subscription: ${this.subscriptionId})`
      );
    } catch (err: any) {
      LOG.error(`Failed to start pool listener: ${err.message}`);
      throw err;
    }
  }

  /**
   * Stop listening for new pools
   */
  async stopListening() {
    if (!this.isListening || this.subscriptionId === null) {
      return;
    }

    try {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.isListening = false;
      this.subscriptionId = null;
      LOG.info("Raydium pool listener stopped");
    } catch (err: any) {
      LOG.error(`Error stopping pool listener: ${err.message}`);
    }
  }

  /**
   * Add pool to processing queue (rate-limited)
   */
  private queuePool(signature: string, slot: number) {
    // Skip if queue is full (prevent memory overflow)
    if (this.poolQueue.length >= this.MAX_QUEUE_SIZE) {
      LOG.warn(
        { queueSize: this.poolQueue.length },
        "Queue full, dropping oldest pool"
      );
      this.poolQueue.shift(); // Remove oldest
    }

    this.poolQueue.push({
      signature,
      slot,
      timestamp: Date.now(),
    });
  }

  /**
   * Process pool queue with rate limiting
   */
  private startQueueProcessor() {
    if (this.isProcessing) return;

    this.isProcessing = true;
    this.processQueue();
  }

  private async processQueue() {
    while (this.isListening && this.isProcessing) {
      try {
        // Process multiple pools in parallel if queue is backed up
        const batchSize = Math.min(
          this.CONCURRENT_VALIDATIONS - this.activeValidations,
          this.poolQueue.length
        );

        if (batchSize > 0) {
          const batch = this.poolQueue.splice(0, batchSize);

          LOG.debug(
            { queue: this.poolQueue.length, processing: batchSize },
            `Processing ${batchSize} pools in parallel`
          );

          // Process batch concurrently (don't await)
          batch.forEach((poolData) => {
            this.activeValidations++;
            this.handleNewPool(poolData.signature, poolData.slot)
              .catch((err) =>
                LOG.error({ err: err.message }, "Pool processing error")
              )
              .finally(() => this.activeValidations--);
          });
        }

        // Rate limit: wait before checking queue again
        await new Promise((resolve) =>
          setTimeout(resolve, this.PROCESS_INTERVAL_MS)
        );
      } catch (err: any) {
        LOG.error({ err: err.message }, "Queue processing error");
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Back off on error
      }
    }

    this.isProcessing = false;
  }

  /**
   * Handle newly detected pool
   */
  private async handleNewPool(signature: string, slot: number) {
    try {
      // Get transaction details with retry logic
      const tx = await this.retryRpcCall(
        () =>
          this.connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          }),
        3,
        1000
      );

      if (!tx || !tx.meta || !tx.transaction) {
        LOG.warn(`Could not fetch transaction: ${signature}`);
        return;
      }

      // Extract pool information from transaction
      const poolInfo = this.extractPoolInfo(tx);
      if (!poolInfo) {
        LOG.debug(`No pool info extracted from ${signature}`);
        return;
      }

      // Skip if already detected
      if (this.detectedPools.has(poolInfo.poolId)) {
        return;
      }

      this.detectedPools.add(poolInfo.poolId);

      LOG.info(
        {
          poolId: poolInfo.poolId.slice(0, 8),
          lpSol: poolInfo.liquiditySol,
        },
        `🔍 Analyzing pool: ${poolInfo.tokenMint.slice(0, 8)}...`
      );

      // Emit pool detected event to frontend
      if (this.io) {
        this.io.emit("raydium:pool_detected", {
          tokenMint: poolInfo.tokenMint,
          poolId: poolInfo.poolId,
          liquiditySol: poolInfo.liquiditySol,
          timestamp: new Date().toISOString(),
        });
      }

      // Check if pool meets minimum liquidity for display
      const meetsLiquidityThreshold =
        poolInfo.liquiditySol >= this.config.minLiquiditySol;

      if (meetsLiquidityThreshold) {
        // Add to tracked tokens for frontend display (manual trading opportunity)
        addTrackedToken(poolInfo.tokenMint, "NEW");
        LOG.info(
          { lpSol: poolInfo.liquiditySol },
          `📊 Token meets liquidity threshold: ${poolInfo.tokenMint.slice(
            0,
            8
          )}... (available for manual buy)`
        );
      }

      // Validate pool against ALL safety criteria (for auto-buy)
      const validation = await validateRaydiumPool(
        poolInfo.tokenMint,
        poolInfo.poolId,
        {
          minLiquiditySol: this.config.minLiquiditySol,
          maxBuyTax: this.config.maxBuyTax,
          maxSellTax: this.config.maxSellTax,
          requireMintDisabled: this.config.requireMintDisabled,
          requireFreezeDisabled: this.config.requireFreezeDisabled,
          requireLpLocked: this.config.requireLpLocked,
        },
        poolInfo.liquiditySol // Pass the correct liquidity value
      );

      // Store in database
      await dbService.upsertTokenState({
        mint: poolInfo.tokenMint,
        state: validation.approved
          ? "RAYDIUM_POOL_CREATED"
          : "AWAITING_GRADUATION",
        source: "raydium",
        raydiumPoolExists: true,
        liquidityUSD: poolInfo.liquiditySol * 150,
        detectedAt: new Date(),
      });

      if (!validation.approved) {
        LOG.warn(
          {
            token: poolInfo.tokenMint.slice(0, 8),
            filters: validation.failedFilters,
            lpSol: poolInfo.liquiditySol,
          },
          `⚠️ Pool failed auto-buy validation (available for manual buy): ${validation.reason}`
        );

        // Emit validation failed event (but token still available for manual buy)
        if (this.io) {
          this.io.emit("raydium:validation_failed", {
            tokenMint: poolInfo.tokenMint,
            poolId: poolInfo.poolId,
            reason: validation.reason,
            failedFilters: validation.failedFilters,
            liquiditySol: poolInfo.liquiditySol,
            availableForManualBuy: meetsLiquidityThreshold,
            timestamp: new Date().toISOString(),
          });
        }
        return; // Skip auto-buy but token is already added to frontend
      }

      LOG.info(
        {
          lpSol: poolInfo.liquiditySol,
          filters: validation.passedFilters,
        },
        `✅ Pool passed all safety checks (eligible for auto-buy): ${poolInfo.tokenMint.slice(
          0,
          8
        )}...`
      );

      // Emit validation passed event
      if (this.io) {
        this.io.emit("raydium:validation_passed", {
          tokenMint: poolInfo.tokenMint,
          poolId: poolInfo.poolId,
          liquiditySol: poolInfo.liquiditySol,
          passedFilters: validation.passedFilters,
          timestamp: new Date().toISOString(),
        });
      }

      // Execute auto-buy ONLY if ALL validations passed
      if (
        this.config.autoBuyEnabled &&
        this.config.autoBuyAmountSol > 0 &&
        poolInfo
      ) {
        LOG.info(`🚀 Starting 8-stage validation pipeline for auto-buy...`);

        // Run the complete 8-stage validation pipeline
        const pipelineResult = await validationPipelineService.runPipeline(
          poolInfo.tokenMint,
          poolInfo.liquiditySol
        );

        if (!pipelineResult.success) {
          LOG.error(
            {
              token: poolInfo.tokenMint.slice(0, 8),
              failedStage: pipelineResult.failedStage,
              stageName: pipelineResult.failedStageName,
              reason: pipelineResult.reason,
            },
            `❌ Pipeline failed at Stage ${pipelineResult.failedStage}: ${pipelineResult.failedStageName}`
          );

          // Emit pipeline failure event
          if (this.io) {
            this.io.emit("raydium:pipeline_failed", {
              tokenMint: poolInfo.tokenMint,
              poolId: poolInfo.poolId,
              failedStage: pipelineResult.failedStage,
              failedStageName: pipelineResult.failedStageName,
              reason: pipelineResult.reason,
              results: pipelineResult.results,
              timestamp: new Date().toISOString(),
            });
          }
          return;
        }

        LOG.info(
          {
            token: poolInfo.tokenMint.slice(0, 8),
            signature: pipelineResult.executionResult?.signature,
          },
          `✅ Pipeline completed successfully! Buy executed via Flux.`
        );

        // Start P&L tracking (Stage 7)
        if (pipelineResult.executionResult) {
          pnlTrackerService.startTracking({
            tokenMint: poolInfo.tokenMint,
            entryPrice: pipelineResult.executionResult.actualPrice || 0,
            amount: pipelineResult.executionResult.tokensReceived || 0,
            wallet: process.env.WALLET_PUBLIC_KEY || "",
            entryTime: Date.now(),
          });
        }

        // Emit pipeline success event
        if (this.io) {
          this.io.emit("raydium:pipeline_success", {
            tokenMint: poolInfo.tokenMint,
            poolId: poolInfo.poolId,
            signature: pipelineResult.executionResult?.signature,
            tokensReceived: pipelineResult.executionResult?.tokensReceived,
            actualPrice: pipelineResult.executionResult?.actualPrice,
            results: pipelineResult.results,
            timestamp: new Date().toISOString(),
          });
        }

        return;
      }
    } catch (err: any) {
      LOG.error(`Error handling new pool: ${err.message}`);
    }
  }

  /**
   * Extract pool information from transaction
   */
  private extractPoolInfo(tx: any): {
    poolId: string;
    tokenMint: string;
    liquiditySol: number;
  } | null {
    try {
      // Look for pool account and token mint in transaction
      const accounts = tx.transaction.message.accountKeys || [];
      const instructions = tx.transaction.message.instructions || [];

      // The pool ID is typically the first account after program ID
      // Token mint and LP info need to be extracted from instruction data
      // This is a simplified extraction - actual implementation may vary

      // For now, extract from post-token balances
      const postBalances = tx.meta.postTokenBalances || [];
      const preBalances = tx.meta.preTokenBalances || [];

      // Find SOL change to estimate initial LP
      const solChange =
        (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
      const liquiditySol = Math.abs(solChange);

      // Find token mint from first token account
      let tokenMint = "";
      for (const balance of postBalances) {
        if (
          balance.mint &&
          balance.mint !== "So11111111111111111111111111111111111111112"
        ) {
          tokenMint = balance.mint;
          break;
        }
      }

      if (!tokenMint) {
        return null;
      }

      // Pool ID is typically in account keys
      const poolId = accounts[1]?.pubkey?.toString() || "";

      return {
        poolId,
        tokenMint,
        liquiditySol,
      };
    } catch (err: any) {
      LOG.error(`Failed to extract pool info: ${err.message}`);
      return null;
    }
  }

  /**
   * Get listener status
   */
  getStatus() {
    return {
      isListening: this.isListening,
      detectedPoolsCount: this.detectedPools.size,
      config: this.config,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<PoolDetectionConfig>) {
    this.config = { ...this.config, ...updates };
    LOG.info(updates, "Pool listener config updated");
  }
}

// Export singleton instance
export const raydiumPoolListener = new RaydiumPoolListener();
