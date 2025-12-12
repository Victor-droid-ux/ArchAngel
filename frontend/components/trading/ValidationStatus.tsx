"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@components/ui/card";
import { Badge } from "@components/ui/badge";
import { CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";

interface BondingCurveMetrics {
  progress: number;
  marketCapUSD: number;
  transactionCount: number;
  buyVolumeUSD: number;
  sellVolumeUSD: number;
  holderCount: number;
  isAboutToGraduate: boolean;
}

interface RaydiumPoolMetrics {
  exists: boolean;
  liquiditySOL: number;
  liquidityUSD: number;
  poolAddress?: string;
  lpTokensMinted: boolean;
  meetsMinimumLiquidity: boolean;
}

interface SafetyChecks {
  canSell: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  firstThreeCandlesValid: boolean;
  lpRemovable: boolean;
  allChecksPassed: boolean;
}

interface TradeValidationResult {
  mint: string;
  approved: boolean;
  bondingMetrics: BondingCurveMetrics;
  condition1Passed: boolean;
  raydiumMetrics: RaydiumPoolMetrics;
  condition2Passed: boolean;
  safetyChecks: SafetyChecks;
  condition3Passed: boolean;
  recommendation: "BUY" | "WAIT" | "IGNORE";
  reason: string;
  timestamp: number;
}

interface ValidationStatusProps {
  validation: TradeValidationResult | null;
}

export function ValidationStatus({ validation }: ValidationStatusProps) {
  if (!validation) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Token Validation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No validation data available
          </p>
        </CardContent>
      </Card>
    );
  }

  const getRecommendationBadge = () => {
    if (validation.recommendation === "BUY") {
      return (
        <Badge className="bg-green-500">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          APPROVED
        </Badge>
      );
    } else if (validation.recommendation === "WAIT") {
      return (
        <Badge className="bg-yellow-500">
          <Clock className="mr-1 h-3 w-3" />
          WAIT
        </Badge>
      );
    } else {
      return (
        <Badge variant="destructive">
          <XCircle className="mr-1 h-3 w-3" />
          IGNORE
        </Badge>
      );
    }
  };

  const getConditionIcon = (passed: boolean) => {
    return passed ? (
      <CheckCircle2 className="h-4 w-4 text-green-500" />
    ) : (
      <XCircle className="h-4 w-4 text-red-500" />
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Trade Validation</CardTitle>
          {getRecommendationBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Reason */}
        <div className="rounded-md bg-muted p-3">
          <p className="text-sm font-medium">{validation.reason}</p>
        </div>

        {/* Condition 1: About to Graduate */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {getConditionIcon(validation.condition1Passed)}
            <h4 className="text-sm font-semibold">
              Condition 1: About to Graduate
            </h4>
          </div>
          <div className="ml-6 space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>Bonding Progress:</span>
              <span className="font-mono">
                {validation.bondingMetrics.progress.toFixed(1)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span>Market Cap:</span>
              <span className="font-mono">
                ${validation.bondingMetrics.marketCapUSD.toFixed(0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Transactions:</span>
              <span className="font-mono">
                {validation.bondingMetrics.transactionCount}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Buy/Sell Volume:</span>
              <span className="font-mono">
                ${validation.bondingMetrics.buyVolumeUSD.toFixed(0)} / $
                {validation.bondingMetrics.sellVolumeUSD.toFixed(0)}
              </span>
            </div>
          </div>
        </div>

        {/* Condition 2: Raydium Migration */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {getConditionIcon(validation.condition2Passed)}
            <h4 className="text-sm font-semibold">
              Condition 2: Raydium Migration
            </h4>
          </div>
          <div className="ml-6 space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>Pool Exists:</span>
              <span className="font-mono">
                {validation.raydiumMetrics.exists ? "✅ Yes" : "❌ No"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Liquidity (SOL):</span>
              <span className="font-mono">
                {validation.raydiumMetrics.liquiditySOL.toFixed(2)} SOL
              </span>
            </div>
            <div className="flex justify-between">
              <span>Liquidity (USD):</span>
              <span className="font-mono">
                ${validation.raydiumMetrics.liquidityUSD.toFixed(0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Minimum Met:</span>
              <span className="font-mono">
                {validation.raydiumMetrics.meetsMinimumLiquidity
                  ? "✅ Yes"
                  : "❌ No"}
              </span>
            </div>
          </div>
        </div>

        {/* Condition 3: Safety Checks */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {getConditionIcon(validation.condition3Passed)}
            <h4 className="text-sm font-semibold">
              Condition 3: Safety Checks
            </h4>
          </div>
          <div className="ml-6 space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>Test Sell:</span>
              <span className="font-mono">
                {validation.safetyChecks.canSell ? "✅ Pass" : "❌ Fail"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Mint Authority:</span>
              <span className="font-mono">
                {validation.safetyChecks.mintAuthority === null
                  ? "✅ NULL"
                  : "❌ EXISTS"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Freeze Authority:</span>
              <span className="font-mono">
                {validation.safetyChecks.freezeAuthority === null
                  ? "✅ NULL"
                  : "❌ EXISTS"}
              </span>
            </div>
          </div>
        </div>

        {/* Warning if not approved */}
        {!validation.approved && (
          <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 text-yellow-500" />
              <div className="text-xs">
                <p className="font-semibold text-yellow-500">
                  Trade Not Recommended
                </p>
                <p className="text-muted-foreground">
                  This token does not meet all safety criteria. Trading is
                  blocked.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Timestamp */}
        <p className="text-xs text-muted-foreground">
          Last checked: {new Date(validation.timestamp).toLocaleTimeString()}
        </p>
      </CardContent>
    </Card>
  );
}
