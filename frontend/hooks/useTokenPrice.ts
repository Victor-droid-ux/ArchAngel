// frontend/src/hooks/useTokenPrices.ts
import { useEffect, useState } from "react";
import { socket } from "@lib/socket";
import type { Token } from "../types/token";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

type TokenPricesPayload = {
  tokens: Token[];
};

export function useTokenPrices() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;

    // Initial HTTP fetch for fast first paint
    fetch(`${BACKEND_URL}/api/tokens`)
      .then((res) => res.json())
      .then((json) => {
        if (!mounted) return;
        if (json.success && Array.isArray(json.tokens)) {
          setTokens(json.tokens);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch initial tokens:", err);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    // Live updates via Socket.IO
    const handler = (payload: TokenPricesPayload) => {
      if (!mounted) return;
      setTokens(payload.tokens);
    };

    socket.on("token_prices", handler);

    return () => {
      mounted = false;
      socket.off("token_prices", handler);
    };
  }, []);

  return { tokens, loading };
}
