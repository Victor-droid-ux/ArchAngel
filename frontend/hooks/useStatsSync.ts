// frontend/hooks/useStatsSync.ts
"use client";

import { useEffect } from "react";
import { toast } from "react-hot-toast";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";
import { fetcher } from "@lib/utils";

/**
 * Hybrid stats sync:
 *  - Polls /api/stats every 10s
 *  - Listens for socket "stats:update"
 *  - Writes into Zustand store
 */
export const useStatsSync = () => {
  const { updateStats } = useStats();
  const { lastMessage } = useSocket();

  // 1️⃣ Poll backend periodically
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await fetcher("/api/stats");

        updateStats((prev) => ({
          portfolioValue: Number(data.portfolioValue ?? prev.portfolioValue),
          totalProfitSol: Number(data.totalProfitSol ?? prev.totalProfitSol),
          totalProfitPercent: Number(
            data.totalProfitPercent ?? prev.totalProfitPercent
          ),
          openTrades: Number(data.openTrades ?? prev.openTrades),
          tradeVolumeSol: Number(data.tradeVolumeSol ?? prev.tradeVolumeSol),
          winRate: Number(data.winRate ?? prev.winRate),
        }));
      } catch (err) {
        console.error("❌ Failed to fetch stats:", err);
        toast.error("Unable to load dashboard stats.");
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [updateStats]);

  // 2️⃣ Live updates from socket
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event !== "stats:update") return;

    const s = lastMessage.payload;
    if (!s) return;

    updateStats((prev) => ({
      portfolioValue: Number(s.portfolioValue ?? prev.portfolioValue),
      totalProfitSol: Number(s.totalProfitSol ?? prev.totalProfitSol),
      totalProfitPercent: Number(
        s.totalProfitPercent ?? prev.totalProfitPercent
      ),
      openTrades: Number(s.openTrades ?? prev.openTrades),
      tradeVolumeSol: Number(s.tradeVolumeSol ?? prev.tradeVolumeSol),
      winRate: Number(s.winRate ?? prev.winRate),
    }));
  }, [lastMessage, updateStats]);
};
