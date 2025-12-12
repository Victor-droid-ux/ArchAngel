"use client";

import React, { useEffect } from "react";
import { useTradingConfigStore } from "@hooks/useConfig";
import { Input } from "@components/ui/input";
import { Switch } from "@components/ui/switch";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { toast } from "react-hot-toast";

export const ConfigPanel = () => {
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
    loadConfig,
    syncConfig,
    loadConfigFromAPI,
  } = useTradingConfigStore();

  const { publicKey } = useSolanaWallet();

  // ✅ Load config automatically on mount
  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleLoadCloud = async () => {
    if (!publicKey) {
      toast.error("⚠️ Please connect your wallet first.");
      return;
    }
    try {
      await loadConfigFromAPI(publicKey.toString());
      toast.success("☁️ Config loaded from cloud!");
    } catch {
      toast.error("⚠️ Failed to load from cloud.");
    }
  };

  return (
    <Card className="p-6 bg-base-200 border border-base-300 rounded-xl shadow-md space-y-4">
      <h2 className="text-xl font-semibold text-primary mb-3">
        Trading Configuration
      </h2>

      {/* Trade Amount */}
      <div>
        <label className="text-sm font-medium">Trade Amount (SOL)</label>
        <Input
          type="number"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          placeholder="0.1"
          className="mt-1"
        />
      </div>

      {/* Slippage */}
      <div>
        <label className="text-sm font-medium">Slippage (%)</label>
        <Input
          type="number"
          value={slippage}
          onChange={(e) => setSlippage(Number(e.target.value))}
          placeholder="2"
          className="mt-1"
        />
      </div>

      {/* Take Profit */}
      <div>
        <label className="text-sm font-medium">Take Profit (%)</label>
        <Input
          type="number"
          value={takeProfit}
          onChange={(e) => setTakeProfit(Number(e.target.value))}
          placeholder="10"
          className="mt-1"
        />
      </div>

      {/* Stop Loss */}
      <div>
        <label className="text-sm font-medium">Stop Loss (%)</label>
        <Input
          type="number"
          value={stopLoss}
          onChange={(e) => setStopLoss(Number(e.target.value))}
          placeholder="5"
          className="mt-1"
        />
      </div>

      {/* DEX Route */}
      <div>
        <label className="text-sm font-medium">DEX Route</label>
        <select
          value={dexRoute}
          onChange={(e) => setDexRoute(e.target.value)}
          className="select select-bordered w-full mt-1"
        >
          <option value="Raydium">Raydium</option>
          <option value="Jupiter">Jupiter</option>
          <option value="Orca">Orca</option>
        </select>
      </div>

      {/* Auto Trade Toggle */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-sm font-medium">Enable Auto-Trade</span>
        <Switch checked={autoTrade} onCheckedChange={setAutoTrade} />
      </div>

      {/* Action Buttons */}
      <div className="space-y-2 pt-3">
        <Button
          className="w-full"
          onClick={() => {
            saveConfig();
            syncConfig();
          }}
        >
          💾 Save & Sync
        </Button>

        <Button
          variant="secondary"
          className="w-full"
          onClick={handleLoadCloud}
        >
          ☁️ Load from Cloud
        </Button>
      </div>
    </Card>
  );
};

export default ConfigPanel;
