"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { fetcher, formatNumber } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";
import { useRaydiumEvents } from "@hooks/useRaydiumEvents";
import { useManualBuy } from "@hooks/useManualBuy";
import {
  Loader2,
  CheckCircle,
  XCircle,
  TrendingUp,
  ShoppingCart,
} from "lucide-react";
import { toast } from "react-hot-toast";

type TokenItem = {
  symbol: string;
  name?: string;
  mint?: string;
  price: number;
  pnl?: number;
  liquidity?: number;
  marketCap?: number;
};

type TokensResponse = {
  success: boolean;
  tokens: TokenItem[];
};

export const TokenDiscovery: React.FC = () => {
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [buyingToken, setBuyingToken] = useState<string | null>(null);

  const { lastMessage, connected } = useSocket();
  const {
    validationsPassed,
    validationsFailed,
    autoBuyResults,
    pipelineFailed,
    pipelineSuccess,
    latestValidated,
    latestAutoBuy,
    latestPipelineSuccess,
    latestPipelineFailed,
  } = useRaydiumEvents();

  const { executeManualBuy, loading: manualBuyLoading } = useManualBuy();

  const handleManualBuy = async (tokenMint: string) => {
    setBuyingToken(tokenMint);
    try {
      const result = await executeManualBuy({
        tokenMint,
        amountSol: 0.05, // Default 0.05 SOL
        slippage: 10, // 10% slippage
      });

      if (result?.success) {
        toast.success(`Successfully bought ${tokenMint.slice(0, 8)}...`);
      }
    } catch (error) {
      console.error("Manual buy error:", error);
    } finally {
      setBuyingToken(null);
    }
  };

  const manualBuyTokens = validationsFailed.filter(
    (v) => v.availableForManualBuy
  );

  const loadTokens = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetcher<TokensResponse>("/api/tokens");
      if (res?.success && Array.isArray(res.tokens)) {
        setTokens(res.tokens);
      }
    } catch (err) {
      console.warn("❌ Failed to load tokens:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
    const interval = setInterval(loadTokens, 10000);
    return () => clearInterval(interval);
  }, [loadTokens]);

  // 🔄 Live updates from websocket
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.event !== "token_prices") return;
    const payload = lastMessage.payload;
    if (!Array.isArray(payload?.tokens)) return;

    setTokens(payload.tokens);
  }, [lastMessage]);

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4 flex flex-col max-h-[900px]">
      <CardHeader className="flex items-center justify-between flex-shrink-0">
        <CardTitle className="text-lg font-semibold text-primary">
          New Token Discovery
        </CardTitle>

        <div
          className={`text-xs ${connected ? "text-green-400" : "text-red-400"}`}
        >
          {connected ? "Live" : "Offline"}
        </div>
      </CardHeader>

      <CardContent className="overflow-y-auto flex-1 pr-2">
        {/* Live Activity Feed */}
        <div className="mb-4 space-y-2 max-h-[300px] overflow-y-auto pr-2">
          {/* Show latest pipeline success (8-stage validation passed) */}
          {latestPipelineSuccess && (
            <div className="flex items-center gap-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded text-xs">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-emerald-400">🚀 Pipeline Success:</span>
              <code className="text-gray-300">
                {latestPipelineSuccess.tokenMint.slice(0, 8)}...
              </code>
              <span className="text-gray-400">
                ({latestPipelineSuccess.tokensReceived.toFixed(0)} tokens @{" "}
                {latestPipelineSuccess.actualPrice.toFixed(6)} SOL)
              </span>
              <a
                href={`https://solscan.io/tx/${latestPipelineSuccess.signature}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:underline"
              >
                Tx
              </a>
            </div>
          )}

          {/* Show latest pipeline failed */}
          {latestPipelineFailed && (
            <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs">
              <XCircle className="w-4 h-4 text-red-400" />
              <span className="text-red-400">
                ❌ Stage {latestPipelineFailed.failedStage} Failed:
              </span>
              <code className="text-gray-300">
                {latestPipelineFailed.tokenMint.slice(0, 8)}...
              </code>
              <span className="text-orange-300 text-xs">
                {latestPipelineFailed.failedStageName} -{" "}
                {latestPipelineFailed.reason}
              </span>
            </div>
          )}

          {/* Show latest validation passed (auto-buy eligible) */}
          {latestValidated && (
            <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/20 rounded text-xs">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-green-400">✅ Auto-Buy Eligible:</span>
              <code className="text-gray-300">
                {latestValidated.tokenMint.slice(0, 8)}...
              </code>
              <span className="text-gray-400">
                ({latestValidated.liquiditySol?.toFixed(2)} SOL)
              </span>
            </div>
          )}

          {/* Show latest validation failed but available for manual buy */}
          {validationsFailed[0]?.availableForManualBuy && (
            <div className="flex items-center gap-2 p-2 bg-orange-500/10 border border-orange-500/20 rounded text-xs">
              <TrendingUp className="w-4 h-4 text-orange-400" />
              <span className="text-orange-400">📊 Manual Buy Available:</span>
              <code className="text-gray-300">
                {validationsFailed[0].tokenMint.slice(0, 8)}...
              </code>
              <span className="text-gray-400">
                ({validationsFailed[0].liquiditySol?.toFixed(2)} SOL)
              </span>
              <span className="text-xs text-orange-300">
                - {validationsFailed[0].reason}
              </span>
            </div>
          )}

          {latestAutoBuy && (
            <div
              className={`flex items-center gap-2 p-2 border rounded text-xs ${
                latestAutoBuy.success
                  ? "bg-blue-500/10 border-blue-500/20"
                  : "bg-red-500/10 border-red-500/20"
              }`}
            >
              <TrendingUp
                className={`w-4 h-4 ${
                  latestAutoBuy.success ? "text-blue-400" : "text-red-400"
                }`}
              />
              <span
                className={
                  latestAutoBuy.success ? "text-blue-400" : "text-red-400"
                }
              >
                {latestAutoBuy.success ? "Auto-Buy:" : "Buy Failed:"}
              </span>
              <code className="text-gray-300">
                {latestAutoBuy.tokenMint.slice(0, 8)}...
              </code>
              <span className="text-gray-400">
                {latestAutoBuy.success
                  ? `(${latestAutoBuy.amountSol} SOL)`
                  : `(${latestAutoBuy.error})`}
              </span>
            </div>
          )}
        </div>

        {/* Manual Buy Available Tokens */}
        {manualBuyTokens.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-orange-400 mb-2 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4" />
              Available for Manual Buy ({manualBuyTokens.length})
            </h3>
            <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2">
              {manualBuyTokens.slice(0, 20).map((token) => (
                <div
                  key={token.tokenMint}
                  className="flex items-center justify-between p-3 bg-orange-500/5 border border-orange-500/20 rounded hover:bg-orange-500/10 transition"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono text-gray-300">
                        {token.tokenMint.slice(0, 12)}...
                      </code>
                      <span className="text-xs text-gray-400">
                        {token.liquiditySol
                          ? `${token.liquiditySol.toFixed(2)} SOL`
                          : ""}
                      </span>
                    </div>
                    <div className="text-xs text-orange-300 mt-1">
                      {token.reason}
                    </div>
                  </div>

                  <button
                    onClick={() => handleManualBuy(token.tokenMint)}
                    disabled={
                      buyingToken === token.tokenMint || manualBuyLoading
                    }
                    className="px-3 py-1.5 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition flex items-center gap-1"
                  >
                    {buyingToken === token.tokenMint ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Buying...
                      </>
                    ) : (
                      <>
                        <ShoppingCart className="w-3 h-3" />
                        Buy 0.05 SOL
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token List */}
        {loading ? (
          <div className="flex items-center gap-2 py-6">
            <Loader2 className="animate-spin" />
            <span className="text-sm text-gray-400">Loading tokens...</span>
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-sm text-gray-400 py-4">
            No tokens tracked yet. Validated pools will appear here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-base-300">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-base-200 z-10">
                <tr className="text-left text-gray-400 border-b border-base-300">
                  <th className="py-2 px-4">Token</th>
                  <th className="py-2 px-4 text-right">Price (SOL)</th>
                  <th className="py-2 px-4 text-right">Liquidity</th>
                </tr>
              </thead>
            </table>

            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {tokens.map((t) => (
                    <tr
                      key={t.mint || t.symbol}
                      className="border-b border-base-300 hover:bg-base-300/20 transition"
                    >
                      <td className="py-2 px-4 font-medium">
                        {t.name ?? t.symbol}{" "}
                        <span className="text-xs opacity-60">({t.symbol})</span>
                      </td>

                      <td className="py-2 px-4 text-right">
                        {formatNumber(t.price ?? 0)}
                      </td>

                      <td className="py-2 px-4 text-right">
                        {t.liquidity ? formatNumber(t.liquidity) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TokenDiscovery;
