// components/trading/PositionsPanel.tsx
"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { fetcher, formatNumber } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";
import { Loader2 } from "lucide-react";

type Position = {
  token: string;
  netSol: number;
  avgBuyPrice?: number;
  currentPrice?: number;
  unrealizedPnlPct?: number; // Already % value (e.g. 5 = 5%)
};

export const PositionsPanel: React.FC = () => {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const { lastMessage, connected } = useSocket();

  const loadPositions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetcher("/api/positions");
      if (data?.positions) {
        setPositions(data.positions);
      }
    } catch (err) {
      console.warn("Failed loading positions:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPositions();
    const t = setInterval(loadPositions, 15000);
    return () => clearInterval(t);
  }, [loadPositions]);

  // 🔥 Handle live updates
  useEffect(() => {
    if (!lastMessage) return;

    if (
      lastMessage.event === "tradeFeed" ||
      lastMessage.event === "position:update"
    ) {
      loadPositions();
    }
  }, [lastMessage, loadPositions]);

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-primary flex justify-between">
          <span>Positions</span>
          <span className={connected ? "text-green-400" : "text-red-400"}>
            {connected ? "Live" : "Offline"}
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="animate-spin" />
            <span className="text-sm text-gray-400">Loading positions...</span>
          </div>
        ) : positions.length === 0 ? (
          <div className="text-sm text-gray-400 py-4">No open positions.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-base-300">
                  <th className="py-2">Token</th>
                  <th className="py-2 text-right">Net (SOL)</th>
                  <th className="py-2 text-right">Avg Buy</th>
                  <th className="py-2 text-right">Price</th>
                  <th className="py-2 text-right">Unrealized PnL</th>
                </tr>
              </thead>

              <tbody>
                {positions.map((p) => {
                  const pct = p.unrealizedPnlPct ?? 0;
                  const pnlColor = pct >= 0 ? "text-green-400" : "text-red-400";

                  return (
                    <tr
                      key={p.token}
                      className="border-b border-base-300 hover:bg-base-300/20 transition"
                    >
                      <td className="py-2 font-medium">{p.token}</td>

                      <td className="py-2 text-right">
                        {formatNumber(p.netSol)}
                      </td>

                      <td className="py-2 text-right">
                        {p.avgBuyPrice ? formatNumber(p.avgBuyPrice) : "—"}
                      </td>

                      <td className="py-2 text-right">
                        {p.currentPrice ? formatNumber(p.currentPrice) : "—"}
                      </td>

                      <td
                        className={`py-2 text-right font-semibold ${pnlColor}`}
                      >
                        {pct.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default PositionsPanel;
