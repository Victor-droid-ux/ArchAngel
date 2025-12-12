"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  PlayCircle,
  PauseCircle,
  TrendingUp,
  TrendingDown,
  Zap,
  Loader2,
} from "lucide-react";
import { Button } from "@components/ui/button";
import { useWallet } from "@hooks/useWallet";
import { useTradingConfigStore } from "@hooks/useConfig";
import { useTrade } from "@hooks/useTrade";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";
import { toast } from "react-hot-toast";
import { motion } from "framer-motion";

export default function ActionsBar() {
  const { connected } = useWallet();
  const { selectedToken } = useTradingConfigStore();
  const { executeTrade } = useTrade();
  const { updateStats, stats } = useStats();
  const { sendMessage, connected: socketConnected } = useSocket();

  const [loading, setLoading] = useState(false);
  const [autoTrading, setAutoTrading] = useState(false);

  const handleTrade = useCallback(
    async (type: "buy" | "sell") => {
      if (!connected) {
        toast.error("Please connect your wallet first.");
        return;
      }

      setLoading(true);
      toast.loading(`${type === "buy" ? "Buying" : "Selling"}...`, {
        id: "trade-status",
      });

      try {
        if (!selectedToken) {
          toast.error("Please select a token first");
          return;
        }
        const payload = await executeTrade(type, selectedToken);
        if (!payload) throw new Error("No payload");

        toast.dismiss("trade-status");

        toast.success(
          `${
            payload.simulated ? "🧪 Simulated" : "🚀 Live"
          } ${type.toUpperCase()} ${payload.token} (${payload.amount})`
        );

        // Emit to socket feed
        sendMessage("tradeLog", {
          type: payload.type,
          token: payload.token,
          amount: payload.amount,
          pnl: payload.pnl,
          signature: payload.signature,
          time: new Date().toISOString(),
        });

        // Update local stats
        if (typeof payload.pnl === "number") {
          const profitDelta = payload.pnl * 100; // convert to %
          updateStats({
            totalProfitSol: stats.totalProfitSol + profitDelta / 100,
            totalProfitPercent: stats.totalProfitPercent + profitDelta,
            tradeVolumeSol: stats.tradeVolumeSol + payload.amount,
          });
        }
      } catch (err: any) {
        toast.dismiss("trade-status");
        toast.error("❌ Trade failed");
        console.error(err);
      }

      setLoading(false);
    },
    [connected, executeTrade, selectedToken, sendMessage, updateStats, stats]
  );

  useEffect(() => {
    if (!autoTrading) return;
    const interval = setInterval(() => {
      const randomType = Math.random() > 0.5 ? "buy" : "sell";
      handleTrade(randomType);
    }, 15000);
    return () => clearInterval(interval);
  }, [autoTrading, handleTrade]);

  const toggleAuto = () => {
    if (!connected) {
      toast.error("Connect wallet to enable auto-trading");
      return;
    }
    setAutoTrading((v) => !v);
  };

  return (
    <motion.div
      className="bg-base-200 rounded-xl p-5 flex flex-wrap justify-between items-center gap-4 border border-base-300 shadow-sm"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-2 text-primary">
        <Zap size={18} className="text-yellow-400" />
        <h2 className="text-lg font-semibold">Trading Controls</h2>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        {/* Socket status */}
        <span
          className={`text-xs ${
            socketConnected ? "text-green-400" : "text-red-400"
          }`}
        >
          🔌 {socketConnected ? "Live" : "Offline"}
        </span>

        <Button
          variant="secondary"
          disabled={!connected || loading}
          onClick={() => handleTrade("buy")}
          className="flex items-center gap-2"
        >
          {loading ? <Loader2 className="animate-spin" /> : <TrendingUp />}
          Buy
        </Button>

        <Button
          variant="danger"
          disabled={!connected || loading}
          onClick={() => handleTrade("sell")}
          className="flex items-center gap-2"
        >
          {loading ? <Loader2 className="animate-spin" /> : <TrendingDown />}
          Sell
        </Button>

        <Button
          variant="primary"
          disabled={!connected}
          onClick={toggleAuto}
          className={`flex items-center gap-2 ${
            autoTrading ? "bg-green-700" : ""
          }`}
        >
          {autoTrading ? <PauseCircle /> : <PlayCircle />}
          {autoTrading ? "Stop Auto" : "Auto Trade"}
        </Button>
      </div>
    </motion.div>
  );
}
