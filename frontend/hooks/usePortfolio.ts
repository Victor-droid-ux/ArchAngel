// hooks/usePortfolio.ts
"use client";

import { useEffect } from "react";
import { useWallet } from "./useWallet";
import { useStats } from "./useStats";
import { useSocket } from "./useSocket";

/**
 * Syncs wallet balance with portfolio value
 * Portfolio value = current wallet balance
 * PnL = (current balance - initial balance)
 * Now includes real-time balance updates from backend
 */
export const usePortfolio = () => {
  const { connected, balance, publicKey } = useWallet();
  const { stats, updateStats } = useStats();
  const { lastMessage } = useSocket();

  // Listen for real-time balance updates from backend
  useEffect(() => {
    if (!lastMessage || !connected) return;
    if (lastMessage.event !== "wallet:balance") return;

    const balanceData = lastMessage.payload;
    if (!balanceData || balanceData.wallet !== publicKey) return;

    console.log("💰 Real-time balance update from backend:", {
      balance: balanceData.balance,
      pnl: balanceData.pnl,
    });

    // Update stats with backend-provided balance and PnL
    updateStats({
      portfolioValue: balanceData.balance,
      initialBalance: balanceData.initialBalance,
      totalProfitSol: balanceData.pnl?.sol || 0,
      totalProfitPercent: balanceData.pnl?.percent || 0,
    });
  }, [lastMessage, connected, publicKey, updateStats]);

  // Initialize portfolio when wallet connects
  useEffect(() => {
    if (connected && balance > 0 && stats.initialBalance === 0) {
      console.log("💼 Initializing portfolio with balance:", balance, "SOL");
      updateStats({
        initialBalance: balance,
        portfolioValue: balance,
        totalProfitSol: 0,
        totalProfitPercent: 0,
      });
    }
  }, [connected, balance, stats.initialBalance, updateStats]);

  // Update portfolio value when wallet balance changes
  useEffect(() => {
    if (!connected || !publicKey) {
      // Reset portfolio when disconnected
      updateStats({
        portfolioValue: 0,
        initialBalance: 0,
        totalProfitSol: 0,
        totalProfitPercent: 0,
      });
      return;
    }

    if (balance > 0 && stats.initialBalance > 0) {
      const profitSol = balance - stats.initialBalance;
      const profitPercent =
        stats.initialBalance > 0 ? (profitSol / stats.initialBalance) * 100 : 0;

      console.log("💰 Portfolio updated:", {
        balance,
        initial: stats.initialBalance,
        profit: profitSol,
        profitPct: profitPercent,
      });

      updateStats({
        portfolioValue: balance,
        totalProfitSol: profitSol,
        totalProfitPercent: profitPercent,
      });
    }
  }, [balance, connected, publicKey, stats.initialBalance, updateStats]);

  // Update portfolio after trades complete (via socket)
  useEffect(() => {
    if (!lastMessage || !connected) return;
    if (lastMessage.event !== "tradeFeed") return;

    console.log(
      "📊 Trade detected, portfolio will update on next balance refresh"
    );
    // Balance will auto-refresh via useWallet's interval
  }, [lastMessage, connected]);

  return {
    portfolioValue: stats.portfolioValue,
    totalProfitSol: stats.totalProfitSol,
    totalProfitPercent: stats.totalProfitPercent,
    initialBalance: stats.initialBalance,
  };
};
