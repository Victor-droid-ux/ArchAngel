// app/providers/SocketProvider.tsx
"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { io, Socket } from "socket.io-client";
import { socket } from "@lib/socket";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useTradingConfigStore } from "@hooks/useConfig";

interface SocketData {
  event: string;
  payload: any;
}

interface SocketContextValue {
  connected: boolean;
  lastMessage: SocketData | null;
  send: (event: string, payload?: any) => void;
  socket?: Socket | null;
}

const SocketContext = createContext<SocketContextValue>({
  connected: false,
  lastMessage: null,
  send: () => {},
  socket: null,
});

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<SocketData | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const { publicKey } = useSolanaWallet();
  const { autoTrade, amount } = useTradingConfigStore();

  useEffect(() => {
    const SOCKET_URL =
      process.env.NEXT_PUBLIC_SOCKET_URL ||
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      "http://localhost:4000";
    // create socket
    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));

    // Unified update event (server emits update), plus dedicated channels
    socket.on("update", (data) => {
      setLastMessage({
        event: data?.event ?? "update",
        payload: data?.payload ?? data,
      });
    });

    socket.on("tradeFeed", (payload) => {
      setLastMessage({ event: "tradeFeed", payload });
    });

    socket.on("tokenFeed", (payload) => {
      setLastMessage({ event: "tokenFeed", payload });
    });

    socket.on("priceUpdate", (payload) => {
      setLastMessage({ event: "priceUpdate", payload });
    });

    socket.on("autoTradeRequest", (payload) => {
      setLastMessage({ event: "autoTradeRequest", payload });
    });

    socket.on("validationResult", (payload) => {
      setLastMessage({ event: "validationResult", payload });
    });

    socket.on("tradeError", (payload) => {
      setLastMessage({ event: "tradeError", payload });
    });

    socket.on("pnl:update", (payload) => {
      setLastMessage({ event: "pnl:update", payload });
    });

    socket.on("wallet:balance", (payload) => {
      setLastMessage({ event: "wallet:balance", payload });
    });

    socket.on("position:trailingUpdate", (payload) => {
      setLastMessage({ event: "position:trailingUpdate", payload });
    });

    return () => {
      try {
        socket.disconnect();
      } catch {}
    };
  }, []);

  // Identify wallet when connected
  useEffect(() => {
    if (connected && publicKey && socketRef.current) {
      console.log("🆔 Identifying wallet with backend:", publicKey.toString());
      socketRef.current.emit("identify", {
        wallet: publicKey.toString(),
        autoMode: autoTrade,
        manualAmountSol: amount,
      });
    }
  }, [connected, publicKey, autoTrade, amount]);

  const send = (event: string, payload?: any) => {
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit(event, payload);
    }
  };

  return (
    <SocketContext.Provider
      value={{ connected, lastMessage, send, socket: socketRef.current }}
    >
      {children}
    </SocketContext.Provider>
  );
};

export const useSocketContext = () => useContext(SocketContext);
