"use client";

import React, { useEffect } from "react";
import { Input } from "@components/ui/input";
import { Switch } from "@components/ui/switch";
import { Button } from "@components/ui/button";
import { toast } from "react-hot-toast";
import { useTradingConfigStore } from "@hooks/useConfig";
import { useSocket } from "@hooks/useSocket";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction, Connection } from "@solana/web3.js";
import { fetcher } from "@lib/utils";

// Optional DEX routing presets
const DEX_ROUTES = [
  { id: "Raydium", label: "Raydium (Default)" },
  { id: "Jupiter", label: "Jupiter" },
  { id: "Orca", label: "Orca" },
];

export const TradingConfigPanel = () => {
  const {
    amount,
    slippage,
    takeProfit,
    stopLoss,
    autoTrade,
    dexRoute,
    setAmount,
    setSlippage,
    setTakeProfit,
    setStopLoss,
    setAutoTrade,
    setDexRoute,
    saveConfig,
    syncConfig,
    loadConfig,
    loadConfigFromAPI,
  } = useTradingConfigStore();

  const { lastMessage } = useSocket();
  const { publicKey, signTransaction } = useSolanaWallet();

  // Load user config when component mounts
  useEffect(() => {
    loadConfig?.();
  }, [loadConfig]);

  // Handle auto-trade requests from backend
  useEffect(() => {
    if (!lastMessage || lastMessage.event !== "autoTradeRequest") return;
    if (!publicKey || !signTransaction) return;

    const executeAutoTrade = async () => {
      try {
        const { token, recommendedAmountLamports } = lastMessage.payload;

        // Only auto-execute if user still has autoMode enabled
        const settings = await fetcher(
          `/api/user/settings?wallet=${publicKey.toString()}`
        );
        if (!settings.data?.autoMode) return;

        // Call server to prepare swap
        const prepare = await fetcher("/api/trade/prepare", {
          method: "POST",
          body: JSON.stringify({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: token.mint,
            amountLamports: recommendedAmountLamports,
            userPublicKey: publicKey.toString(),
            slippage: slippage || 1,
          }),
        });

        const swapBase64 = prepare.data.swapTransactionBase64;

        // Use wallet adapter to sign & send transaction
        const tx = VersionedTransaction.deserialize(
          Buffer.from(swapBase64, "base64")
        );

        // Sign locally
        const signedTx = await signTransaction(tx);
        const raw = signedTx.serialize();

        // Send transaction
        const rpcUrl =
          process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
          "https://api.mainnet-beta.solana.com";
        const connection = new Connection(rpcUrl, "confirmed");
        const sig = await connection.sendRawTransaction(raw, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await connection.confirmTransaction(sig, "confirmed");

        // Inform backend
        await fetcher("/api/trade/confirm", {
          method: "POST",
          body: JSON.stringify({
            type: "buy",
            token: token.symbol || token.mint,
            amountLamports: recommendedAmountLamports,
            price: prepare.data.quote?.outAmount
              ? prepare.data.quote.inAmount / prepare.data.quote.outAmount
              : undefined,
            pnl: 0,
            wallet: publicKey.toString(),
            signature: sig,
            simulated: false,
          }),
        });

        toast.success(`🤖 Auto-traded ${token.symbol || "token"}!`);
      } catch (error: any) {
        console.error("Auto-trade failed:", error);
        toast.error(`Auto-trade failed: ${error.message}`);
      }
    };

    executeAutoTrade();
  }, [lastMessage, publicKey, signTransaction, slippage]);

  const handleSave = async () => {
    try {
      saveConfig?.();
      syncConfig?.();
      toast.success("✅ Configuration saved & synced successfully!");
    } catch (error) {
      toast.error("❌ Failed to save configuration.");
      console.error(error);
    }
  };

  const handleLoadCloud = async () => {
    try {
      if (!publicKey) {
        toast.error("⚠️ Please connect your wallet first.");
        return;
      }
      await loadConfigFromAPI?.(publicKey.toString());
      toast.success("☁️ Config loaded from cloud!");
    } catch {
      toast.error("⚠️ Failed to load from cloud.");
    }
  };

  return (
    <div className="bg-base-200 border border-base-300 rounded-xl p-6 space-y-4 shadow-md">
      <h2 className="text-xl font-semibold text-primary mb-2">
        Trading Configuration
      </h2>

      {/* Trade Amount */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Trade Amount (SOL)</label>
        <Input
          type="number"
          min={0}
          step={0.01}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          placeholder="Enter trade amount"
        />
      </div>

      {/* Slippage */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Slippage (%)</label>
        <Input
          type="number"
          min={0.1}
          step={0.1}
          value={slippage}
          onChange={(e) => setSlippage(Number(e.target.value))}
          placeholder="2"
        />
      </div>

      {/* Take Profit */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Take Profit (%)</label>
        <Input
          type="number"
          min={0}
          value={takeProfit}
          onChange={(e) => setTakeProfit(Number(e.target.value))}
          placeholder="10"
        />
      </div>

      {/* Stop Loss */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Stop Loss (%)</label>
        <Input
          type="number"
          min={0}
          value={stopLoss}
          onChange={(e) => setStopLoss(Number(e.target.value))}
          placeholder="5"
        />
      </div>

      {/* DEX Route */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">DEX Route</label>
        <select
          value={dexRoute}
          onChange={(e) => setDexRoute(e.target.value)}
          className="select select-bordered w-full"
        >
          {DEX_ROUTES.map((route) => (
            <option key={route.id} value={route.id}>
              {route.label}
            </option>
          ))}
        </select>
      </div>

      {/* Auto Trade */}
      <div className="flex items-center justify-between py-2">
        <span className="text-sm font-medium">Enable Auto Trade</span>
        <Switch checked={autoTrade} onCheckedChange={setAutoTrade} />
      </div>

      {/* Action Buttons */}
      <div className="flex flex-col gap-3 mt-4">
        <Button onClick={handleSave} className="w-full">
          Save & Sync Configuration
        </Button>

        <Button variant="outline" onClick={handleLoadCloud} className="w-full">
          Load Config from Cloud
        </Button>
      </div>
    </div>
  );
};

export default TradingConfigPanel;
