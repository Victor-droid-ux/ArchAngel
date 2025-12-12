"use client";
import { useEffect } from "react";
import { io } from "socket.io-client";

const socket = io(
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000"
);

export function useTradeSocket(onTrade: (trade: any) => void) {
  useEffect(() => {
    socket.on("connect", () => console.log("🔗 Connected to trade socket"));
    socket.on("trade:update", onTrade);

    return () => {
      socket.off("trade:update", onTrade);
      socket.disconnect();
    };
  }, [onTrade]);
}
