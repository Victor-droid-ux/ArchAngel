// frontend/hooks/useSocket.ts (update)
"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

export function useSocket() {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<any>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionAttempts: 10,
    });

    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => console.error("socket err", err));

    socket.on("update", (data) => setLastMessage(data));
    socket.on("tradeFeed", (data) =>
      setLastMessage({ event: "tradeFeed", payload: data })
    );
    socket.on("tokenFeed", (data) =>
      setLastMessage({ event: "tokenFeed", payload: data })
    );
    socket.on("autoTradeRequest", (data) =>
      setLastMessage({ event: "autoTradeRequest", payload: data })
    );
    socket.on("poolAvailable", (data) =>
      setLastMessage({ event: "poolAvailable", payload: data })
    );
    socket.on("poolMonitorTimeout", (data) =>
      setLastMessage({ event: "poolMonitorTimeout", payload: data })
    );
    socket.on("wallet:balance", (data) =>
      setLastMessage({ event: "wallet:balance", payload: data })
    );
    socket.on("position:trailingUpdate", (data) =>
      setLastMessage({ event: "position:trailingUpdate", payload: data })
    );
    socket.on("tradeError", (data) =>
      setLastMessage({ event: "tradeError", payload: data })
    );

    // Raydium Pool Listener Events
    socket.on("raydium:pool_detected", (data) =>
      setLastMessage({ event: "raydium:pool_detected", payload: data })
    );
    socket.on("raydium:pool_skipped", (data) =>
      setLastMessage({ event: "raydium:pool_skipped", payload: data })
    );
    socket.on("raydium:validation_passed", (data) =>
      setLastMessage({ event: "raydium:validation_passed", payload: data })
    );
    socket.on("raydium:validation_failed", (data) =>
      setLastMessage({ event: "raydium:validation_failed", payload: data })
    );
    socket.on("raydium:auto_buy_complete", (data) =>
      setLastMessage({ event: "raydium:auto_buy_complete", payload: data })
    );

    // 8-Stage Validation Pipeline Events
    socket.on("raydium:pipeline_failed", (data) =>
      setLastMessage({ event: "raydium:pipeline_failed", payload: data })
    );
    socket.on("raydium:pipeline_success", (data) =>
      setLastMessage({ event: "raydium:pipeline_success", payload: data })
    );

    // P&L Tracking Events
    socket.on("pnl:update", (data) =>
      setLastMessage({ event: "pnl:update", payload: data })
    );

    // Stored Token Checker Events
    socket.on("storedTokenChecker:status", (data) =>
      setLastMessage({ event: "storedTokenChecker:status", payload: data })
    );
    socket.on("storedTokenChecker:qualified", (data) =>
      setLastMessage({ event: "storedTokenChecker:qualified", payload: data })
    );

    return () => {
      socket.disconnect();
    };
  }, []);

  const sendMessage = useCallback((event: string, payload?: any) => {
    if (!socketRef.current) return;
    socketRef.current.emit(event, payload);
  }, []);

  const identify = useCallback((payload: any) => {
    if (!socketRef.current) return;
    socketRef.current.emit("identify", payload);
  }, []);

  return {
    connected,
    lastMessage,
    sendMessage,
    identify,
    socket: socketRef.current,
  };
}
export default useSocket;
