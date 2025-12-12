"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  TrendingUp,
  TrendingDown,
  Zap,
  Loader2,
  PlayCircle,
  PauseCircle,
} from "lucide-react";
import { Button } from "@components/ui/button";
import { useTrade } from "@hooks/useTrade";
import { useSocket } from "@hooks/useSocket";
import { useStats } from "@hooks/useStats";
import { useWallet } from "@hooks/useWallet";
import { useTradingConfigStore } from "@hooks/useConfig";
import toast from "react-hot-toast";
import TokenDiscovery from "@components/trading/TokenDiscovery";
import PriceChart from "@components/trading/PriceChart";
import LiveTrades from "@components/trading/LiveTrades";
import PositionsPanel from "@components/trading/PositionsPanel";
import { useStatsSync } from "@hooks/useStatsSync";

export default function TradingPage() {
  // Auto-sync stats from backend
  useStatsSync();

  const { connected } = useWallet();
  const { executeTrade, loading } = useTrade();
  const { connected: socketConnected, lastMessage } = useSocket();
  const { stats } = useStats();
  const { selectedToken } = useTradingConfigStore();

  const [autoTrading, setAutoTrading] = useState(false);
  const [tradeHistory, setTradeHistory] = useState<any[]>([]);

  // ⚡ Simulated auto-trading
  useEffect(() => {
    if (!autoTrading) return;

    const interval = setInterval(() => {
      if (!selectedToken) return;
      const randomType = Math.random() > 0.5 ? "buy" : "sell";
      executeTrade(randomType, selectedToken);
    }, 15000);

    return () => clearInterval(interval);
  }, [autoTrading, executeTrade, selectedToken]);

  // 📡 Listen for trade feed socket messages
  useEffect(() => {
    if (lastMessage?.event !== "tradeFeed") return;

    const trade = lastMessage.payload;
    setTradeHistory((prev) => [trade, ...prev.slice(0, 19)]);

    toast.success(
      `${trade.type.toUpperCase()} ${trade.amount} ${
        trade.token
      } trade received!`,
      { duration: 3000 }
    );
  }, [lastMessage]);

  const handleTrade = async (type: "buy" | "sell") => {
    if (!connected) {
      toast.error("Please connect your wallet first!");
      return;
    }
    if (!selectedToken) {
      toast.error("Please select a token first!");
      return;
    }
    await executeTrade(type, selectedToken);
  };

  const toggleAutoTrade = () => {
    if (!connected) {
      toast.error("Connect wallet before enabling auto-trade.");
      return;
    }
    setAutoTrading((prev) => !prev);

    toast.success(
      !autoTrading ? "🤖 Auto-trade enabled" : "✋ Auto-trade paused"
    );
  };

  return (
    <motion.div
      className="space-y-8 container mx-auto px-4 py-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="flex justify-between items-center gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <Zap size={22} /> Trading Panel
        </h1>
        <span
          className={`text-sm ${
            socketConnected ? "text-green-400" : "text-red-400"
          }`}
        >
          Socket: {socketConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* ⚙️ Trade Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Button
          variant="secondary"
          onClick={() => handleTrade("buy")}
          disabled={loading || !connected}
          className="flex gap-2 text-lg py-4"
        >
          {loading ? <Loader2 className="animate-spin" /> : <TrendingUp />}
          {loading
            ? "Executing..."
            : selectedToken
            ? `Buy ${selectedToken}`
            : "Select Token"}
        </Button>

        <Button
          variant="danger"
          onClick={() => handleTrade("sell")}
          disabled={loading || !connected}
          className="flex gap-2 text-lg py-4"
        >
          {loading ? <Loader2 className="animate-spin" /> : <TrendingDown />}
          {loading
            ? "Executing..."
            : selectedToken
            ? `Sell ${selectedToken}`
            : "Select Token"}
        </Button>

        <Button
          variant="primary"
          onClick={toggleAutoTrade}
          disabled={!connected}
          className={`flex gap-2 text-lg py-4 ${
            autoTrading ? "bg-green-700" : ""
          }`}
        >
          {autoTrading ? (
            <>
              <PauseCircle /> Stop Auto-Trade
            </>
          ) : (
            <>
              <PlayCircle /> Start Auto-Trade
            </>
          )}
        </Button>
      </div>

      {/* 📊 Live Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm bg-base-200 p-4 rounded-xl">
        <p>
          Total Profit:{" "}
          <span className="text-green-400">
            {stats.totalProfitPercent.toFixed(2)}%
          </span>
        </p>
        <p>
          Trade Volume:{" "}
          <span className="text-primary">
            {stats.tradeVolumeSol.toFixed(4)} SOL
          </span>
        </p>
        <p>
          Open Trades:{" "}
          <span className="text-yellow-400">{stats.openTrades}</span>
        </p>
      </div>

      {/* 🧾 Recent Trades */}
      <div className="bg-base-200 rounded-xl p-4">
        <h3 className="text-primary font-semibold mb-2">Recent Trades</h3>
        <div className="h-64 overflow-y-auto text-sm font-mono space-y-2">
          {tradeHistory.length === 0 && (
            <p className="text-gray-500 italic">No trades yet...</p>
          )}

          {tradeHistory.map((t, idx) => (
            <div
              key={idx}
              className={`p-2 rounded ${
                t.type === "buy"
                  ? "bg-green-900/20 text-green-400"
                  : "bg-red-900/20 text-red-400"
              }`}
            >
              [{t.time}] {t.type.toUpperCase()} {t.amount} {t.token}
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
