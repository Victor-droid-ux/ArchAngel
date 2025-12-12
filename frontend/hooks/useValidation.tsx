"use client";

import { useEffect, useState } from "react";
import { useSocket } from "./useSocket";

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

export interface TradeValidationResult {
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

export function useValidation(tokenMint?: string) {
  const { socket, connected } = useSocket();
  const [validation, setValidation] = useState<TradeValidationResult | null>(
    null
  );
  const [isValidating, setIsValidating] = useState(false);

  useEffect(() => {
    if (!socket || !connected) return;

    // Listen for validation results from auto-buyer
    const handleValidationResult = (result: TradeValidationResult) => {
      // If we're watching a specific token, filter for it
      if (!tokenMint || result.mint === tokenMint) {
        setValidation(result);
        setIsValidating(false);
      }
    };

    socket.on("validationResult", handleValidationResult);

    return () => {
      socket.off("validationResult", handleValidationResult);
    };
  }, [socket, connected, tokenMint]);

  const validateToken = async (mint: string) => {
    setIsValidating(true);
    try {
      const response = await fetch("/api/trade/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMint: mint }),
      });

      const data = await response.json();
      if (data.success && data.validation) {
        setValidation(data.validation);
      }
    } catch (error) {
      console.error("Validation error:", error);
    } finally {
      setIsValidating(false);
    }
  };

  return {
    validation,
    isValidating,
    validateToken,
  };
}
