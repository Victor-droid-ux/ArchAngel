"use client";

import { useEffect, useState } from "react";
import { useSocket } from "./useSocket";

export interface RaydiumPoolEvent {
  tokenMint: string;
  poolId: string;
  liquiditySol: number;
  queueSize?: number;
  activeValidations?: number;
  meetsLiquidityThreshold?: boolean;
  timestamp: string;
}

export interface RaydiumPoolSkippedEvent {
  tokenMint: string;
  poolId: string;
  reason: string;
  liquiditySol?: number;
  requiredSol?: number;
  ageMinutes?: string;
  maxAgeMinutes?: string;
  previousState?: string;
  timestamp: string;
}

export interface RaydiumValidationEvent {
  tokenMint: string;
  poolId: string;
  reason?: string;
  failedFilters?: string[];
  passedFilters?: string[];
  liquiditySol?: number;
  availableForManualBuy?: boolean;
  timestamp: string;
}

export interface RaydiumAutoBuyEvent {
  tokenMint: string;
  poolId: string;
  amountSol: number;
  tokensReceived?: number;
  signature?: string;
  success: boolean;
  error?: string;
  timestamp: string;
}

export interface PipelineFailedEvent {
  tokenMint: string;
  poolId: string;
  failedStage: number;
  failedStageName: string;
  reason: string;
  results: any[];
  timestamp: string;
}

export interface PipelineSuccessEvent {
  tokenMint: string;
  poolId: string;
  signature: string;
  tokensReceived: number;
  actualPrice: number;
  results: any[];
  timestamp: string;
}

export interface PnLUpdate {
  tokenMint: string;
  wallet: string;
  entryPrice: number;
  currentPrice: number;
  amount: number;
  unrealizedPnL: number;
  percentChange: number;
  priceImpact: number;
  liquidityMovement: number;
  trendDirection: "up" | "down" | "stable";
  timestamp: number;
}

export function useRaydiumEvents() {
  const { lastMessage, connected } = useSocket();
  const [poolsDetected, setPoolsDetected] = useState<RaydiumPoolEvent[]>([]);
  const [poolsSkipped, setPoolsSkipped] = useState<RaydiumPoolSkippedEvent[]>(
    []
  );
  const [validationsPassed, setValidationsPassed] = useState<
    RaydiumValidationEvent[]
  >([]);
  const [validationsFailed, setValidationsFailed] = useState<
    RaydiumValidationEvent[]
  >([]);
  const [autoBuyResults, setAutoBuyResults] = useState<RaydiumAutoBuyEvent[]>(
    []
  );
  const [pipelineFailed, setPipelineFailed] = useState<PipelineFailedEvent[]>(
    []
  );
  const [pipelineSuccess, setPipelineSuccess] = useState<
    PipelineSuccessEvent[]
  >([]);
  const [pnlUpdates, setPnlUpdates] = useState<Map<string, PnLUpdate>>(
    new Map()
  );

  useEffect(() => {
    if (!lastMessage) return;

    switch (lastMessage.event) {
      case "raydium:pool_detected":
        setPoolsDetected((prev) => [lastMessage.payload, ...prev].slice(0, 50));
        break;

      case "raydium:pool_skipped":
        setPoolsSkipped((prev) => [lastMessage.payload, ...prev].slice(0, 100));
        break;

      case "raydium:validation_passed":
        setValidationsPassed((prev) =>
          [lastMessage.payload, ...prev].slice(0, 20)
        );
        break;

      case "raydium:validation_failed":
        setValidationsFailed((prev) =>
          [lastMessage.payload, ...prev].slice(0, 50)
        );
        break;

      case "raydium:auto_buy_complete":
        setAutoBuyResults((prev) =>
          [lastMessage.payload, ...prev].slice(0, 20)
        );
        break;

      case "raydium:pipeline_failed":
        setPipelineFailed((prev) =>
          [lastMessage.payload, ...prev].slice(0, 50)
        );
        break;

      case "raydium:pipeline_success":
        setPipelineSuccess((prev) =>
          [lastMessage.payload, ...prev].slice(0, 20)
        );
        break;

      case "pnl:update":
        setPnlUpdates((prev) => {
          const updated = new Map(prev);
          updated.set(lastMessage.payload.tokenMint, lastMessage.payload);
          return updated;
        });
        break;
    }
  }, [lastMessage]);

  return {
    connected,
    poolsDetected,
    poolsSkipped,
    validationsPassed,
    validationsFailed,
    autoBuyResults,
    pipelineFailed,
    pipelineSuccess,
    pnlUpdates,
    latestValidated: validationsPassed[0],
    latestAutoBuy: autoBuyResults[0],
    latestPipelineSuccess: pipelineSuccess[0],
    latestPipelineFailed: pipelineFailed[0],
    totalPoolsSkipped: poolsSkipped.length,
    skipReasons: poolsSkipped.reduce((acc, skip) => {
      acc[skip.reason] = (acc[skip.reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };
}
