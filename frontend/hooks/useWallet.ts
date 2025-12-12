"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import { useSocket } from "./useSocket";
import { useTradingConfigStore } from "./useConfig";

interface WalletState {
  connected: boolean;
  publicKey: string | null;
  balance: number;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  refreshBalance: () => Promise<void>;
}

export const useWallet = (): WalletState => {
  const solanaWallet = useSolanaWallet();
  const [currentSolBalance, setCurrentSolBalance] = useState<number>(0);

  const { identify } = useSocket();
  const { autoTrade, amount } = useTradingConfigStore();

  // Sync connection state from Solana wallet adapter
  const connected = solanaWallet.connected;
  const publicKey = solanaWallet.publicKey?.toString() || null;

  /* -------------------------------------------------
     Connect - Use Solana wallet adapter's connect
  ------------------------------------------------- */
  const connectWallet = useCallback(async () => {
    try {
      console.log("🔍 Checking wallet adapter:", {
        hasWallet: !!solanaWallet.wallet,
        walletName: solanaWallet.wallet?.adapter?.name,
        connected: solanaWallet.connected,
        wallets: solanaWallet.wallets?.length,
      });

      // Check if Phantom is installed in window object
      if (typeof window !== "undefined") {
        console.log("🔍 Window wallet objects:", {
          phantom: !!(window as any).solana?.isPhantom,
          solflare: !!(window as any).solflare,
        });
      }

      // This will trigger the wallet selection modal if no wallet is connected
      await solanaWallet.connect();
      console.log(
        "✅ Wallet connected via adapter:",
        solanaWallet.publicKey?.toString()
      );
    } catch (err) {
      console.error("❌ Wallet connection failed:", err);
      // Check if it's a user rejection or actual error
      if (err instanceof Error && !err.message.includes("User rejected")) {
        alert(
          "No wallet detected. Please install Phantom or Solflare wallet extension and refresh the page."
        );
      }
    }
  }, [solanaWallet]);

  /* -------------------------------------------------
     Disconnect - Use Solana wallet adapter's disconnect
  ------------------------------------------------- */
  const disconnectWallet = useCallback(async () => {
    try {
      await solanaWallet.disconnect();
      setCurrentSolBalance(0);
      console.log("👋 Wallet disconnected by user");
    } catch (err) {
      console.error("Disconnect error:", err);
    }
  }, [solanaWallet]);

  /* -------------------------------------------------
     Refresh Balance
  ------------------------------------------------- */
  const refreshBalance = useCallback(async () => {
    if (!solanaWallet.publicKey || !connected) {
      console.log("⏭️ Skipping balance refresh - wallet not connected");
      return;
    }

    try {
      const rpcUrl =
        process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
        "https://api.mainnet-beta.solana.com";

      console.log("🔍 Fetching balance from:", rpcUrl);
      console.log("🔍 Wallet address:", solanaWallet.publicKey.toString());

      const connection = new Connection(rpcUrl, "confirmed");
      const balance = await connection.getBalance(solanaWallet.publicKey);
      const balanceSol = balance / 1e9;

      console.log("💰 Balance fetched:", {
        lamports: balance,
        sol: balanceSol,
        wallet: solanaWallet.publicKey.toString().slice(0, 8) + "...",
      });

      setCurrentSolBalance(balanceSol);
    } catch (err) {
      console.error("❌ Failed to refresh balance:", err);
      console.error("Error details:", {
        message: err instanceof Error ? err.message : String(err),
        wallet: solanaWallet.publicKey?.toString(),
        connected,
      });
    }
  }, [solanaWallet.publicKey, connected]);

  /* -------------------------------------------------
     On wallet connection, identify with backend
  ------------------------------------------------- */
  useEffect(() => {
    if (connected && solanaWallet.publicKey) {
      refreshBalance();

      // Identify with backend on connection
      identify({
        wallet: solanaWallet.publicKey.toString(),
        balanceSol: currentSolBalance,
        autoMode: autoTrade,
        manualAmountSol: amount,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, solanaWallet.publicKey]);

  /* -------------------------------------------------
     Auto-refresh balance every 10 seconds
  ------------------------------------------------- */
  useEffect(() => {
    if (!connected || !solanaWallet.publicKey) return;

    const interval = setInterval(() => {
      refreshBalance();
    }, 10000); // Refresh every 10 seconds

    return () => clearInterval(interval);
  }, [connected, solanaWallet.publicKey, refreshBalance]);

  return {
    connected,
    publicKey,
    balance: currentSolBalance,
    connectWallet,
    disconnectWallet,
    refreshBalance,
  };
};
