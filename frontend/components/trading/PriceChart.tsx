// components/trading/PriceChart.tsx
"use client";

import React, { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { useSocket } from "@hooks/useSocket";

type Point = { time: string; value: number };

export const PriceChart: React.FC<{
  tokenMintOrSymbol: string;
}> = ({ tokenMintOrSymbol }) => {
  const { lastMessage } = useSocket();
  const [data, setData] = useState<Point[]>([]);

  useEffect(() => {
    if (!lastMessage) return;

    // 📈 New global token prices update
    if (lastMessage.event === "token_prices") {
      const tokens = lastMessage.payload?.tokens;
      if (!Array.isArray(tokens)) return;

      const match = tokens.find(
        (t: any) =>
          t.symbol === tokenMintOrSymbol || t.mint === tokenMintOrSymbol
      );
      if (!match || !match.price) return;

      const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

      setData((d) => [...d.slice(-119), { time, value: Number(match.price) }]);
    }

    // If backend starts supporting incremental updates later:
    if (lastMessage.event === "priceUpdate") {
      const p = lastMessage.payload;
      if (p?.token === tokenMintOrSymbol || p?.mint === tokenMintOrSymbol) {
        const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
        setData((d) => [...d.slice(-119), { time, value: Number(p.price) }]);
      }
    }
  }, [lastMessage, tokenMintOrSymbol]);

  // seed initial datapoint
  useEffect(() => {
    if (data.length === 0) {
      setData([{ time: new Date().toLocaleTimeString(), value: 0 }]);
    }
  }, [data]);

  return (
    <div className="bg-base-200 border border-base-300 p-4 rounded-xl h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="time" stroke="#666" minTickGap={20} />
          <YAxis stroke="#666" domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1f1f1f",
              border: "1px solid #333",
              borderRadius: 8,
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#8b5cf6"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default PriceChart;
