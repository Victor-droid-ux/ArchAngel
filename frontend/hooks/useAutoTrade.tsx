"use client";

import { useEffect, useState } from "react";
import { useSocketContext } from "@app/providers/SocketProvider";
import { toast } from "react-hot-toast";
import { useTrade } from "@hooks/useTrade";

interface AutoTradeRequest {
  token: {
    mint: string;
    symbol?: string;
    name?: string;
  };
  recommendedAmountLamports: number;
  reason: string;
}

export function useAutoTrade() {
  const { lastMessage } = useSocketContext();
  const { executeTrade } = useTrade();
  const [pendingRequest, setPendingRequest] = useState<AutoTradeRequest | null>(
    null
  );

  useEffect(() => {
    if (lastMessage?.event === "autoTradeRequest") {
      const request = lastMessage.payload as AutoTradeRequest;
      console.log("🤖 Auto-trade request received:", request);

      // Show approval toast
      showAutoTradeToast(request);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage]);

  const showAutoTradeToast = (request: AutoTradeRequest) => {
    const amountSol = (request.recommendedAmountLamports / 1e9).toFixed(4);

    toast(
      (t) => (
        <div className="flex flex-col gap-2 p-2">
          <div className="font-bold text-sm">🤖 Auto-Trade Opportunity</div>
          <div className="text-xs space-y-1">
            <div>
              <span className="font-semibold">Token:</span>{" "}
              {request.token.symbol || request.token.mint.slice(0, 8)}
            </div>
            <div>
              <span className="font-semibold">Amount:</span> {amountSol} SOL
            </div>
            <div>
              <span className="font-semibold">Reason:</span> {request.reason}
            </div>
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => {
                handleApprove(request);
                toast.dismiss(t.id);
              }}
              className="btn btn-primary btn-sm flex-1"
            >
              ✅ Trade
            </button>
            <button
              onClick={() => {
                handleReject(request);
                toast.dismiss(t.id);
              }}
              className="btn btn-ghost btn-sm flex-1"
            >
              ❌ Skip
            </button>
          </div>
        </div>
      ),
      {
        duration: 15000, // 15 seconds to decide
        position: "top-right",
      }
    );
  };

  const handleApprove = async (request: AutoTradeRequest) => {
    console.log("✅ Auto-trade approved:", request.token.symbol);
    toast.loading("Executing auto-trade...", { id: "auto-trade" });

    try {
      await executeTrade("buy", request.token.mint);
      toast.success(`Auto-bought ${request.token.symbol || "token"}!`, {
        id: "auto-trade",
      });
    } catch (error: any) {
      toast.error(`Auto-trade failed: ${error.message}`, { id: "auto-trade" });
    }
  };

  const handleReject = (request: AutoTradeRequest) => {
    console.log("❌ Auto-trade rejected:", request.token.symbol);
    toast.success("Auto-trade skipped", { duration: 2000 });
  };

  return {
    pendingRequest,
  };
}
