// frontend/components/trading/performance-chart.tsx
"use client";

import React, { useEffect, useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";

interface ChartPoint {
  time: string;
  pnl: number;
}

export default function PerformanceChart() {
  const { stats } = useStats();
  const { lastMessage } = useSocket();
  const [history, setHistory] = useState<ChartPoint[]>([]);

  // Add data point when live stats update
  useEffect(() => {
    if (!lastMessage || lastMessage.event !== "stats:update") return;

    const now = new Date().toLocaleTimeString("en-GB", { hour12: false });

    setHistory((prev) => [
      ...prev.slice(-29), // Keep last 30 points for smooth view
      { time: now, pnl: Number(stats.totalProfitPercent) || 0 },
    ]);
  }, [lastMessage, stats.totalProfitPercent]);

  // Default placeholder to render before data arrives
  const data = useMemo(() => {
    if (history.length === 0) {
      return [{ time: "--", pnl: 0 }];
    }
    return history;
  }, [history]);

  return (
    <div className="bg-base-200 rounded-xl p-4 shadow-md">
      <h2 className="text-lg font-semibold mb-3 text-primary">
        Performance Chart
      </h2>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <XAxis dataKey="time" stroke="#888" interval="preserveEnd" />
          <YAxis stroke="#888" domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1d1f21",
              borderRadius: "8px",
              border: "1px solid #333",
            }}
          />
          <Line
            type="monotone"
            dataKey="pnl"
            stroke={stats.totalProfitPercent >= 0 ? "#22c55e" : "#ef4444"}
            strokeWidth={2}
            dot={false}
            isAnimationActive={true}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
