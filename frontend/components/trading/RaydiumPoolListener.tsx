"use client";

import { useState, useEffect } from "react";
import { fetcher } from "@lib/utils";
import { toast } from "react-hot-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@components/ui/card";
import { Button } from "@components/ui/button";
import { Badge } from "@components/ui/badge";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { Switch } from "@components/ui/switch";

interface ListenerStatus {
  isListening: boolean;
  detectedPoolsCount: number;
  config: {
    minLiquiditySol: number;
    maxBuyTax: number;
    maxSellTax: number;
    requireMintDisabled: boolean;
    requireFreezeDisabled: boolean;
    requireLpLocked: boolean;
    autoBuyEnabled: boolean;
    autoBuyAmountSol: number;
  };
}

export function RaydiumPoolListener() {
  const [status, setStatus] = useState<ListenerStatus | null>(null);
  const [loading, setLoading] = useState(false);

  // Config state
  const [minLiquiditySol, setMinLiquiditySol] = useState(20);
  const [maxBuyTax, setMaxBuyTax] = useState(5);
  const [maxSellTax, setMaxSellTax] = useState(5);
  const [requireMintDisabled, setRequireMintDisabled] = useState(true);
  const [requireFreezeDisabled, setRequireFreezeDisabled] = useState(true);
  const [requireLpLocked, setRequireLpLocked] = useState(false);
  const [autoBuyEnabled, setAutoBuyEnabled] = useState(false);
  const [autoBuyAmountSol, setAutoBuyAmountSol] = useState(0.1);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (status?.config) {
      setMinLiquiditySol(status.config.minLiquiditySol);
      setMaxBuyTax(status.config.maxBuyTax);
      setMaxSellTax(status.config.maxSellTax);
      setRequireMintDisabled(status.config.requireMintDisabled);
      setRequireFreezeDisabled(status.config.requireFreezeDisabled);
      setRequireLpLocked(status.config.requireLpLocked);
      setAutoBuyEnabled(status.config.autoBuyEnabled);
      setAutoBuyAmountSol(status.config.autoBuyAmountSol);
    }
  }, [status]);

  const fetchStatus = async () => {
    try {
      const res: any = await fetcher("/api/raydium-listener/status");
      if (res.success) {
        setStatus(res.status);
      }
    } catch (err: any) {
      console.error("Failed to fetch listener status:", err);
    }
  };

  const handleStart = async () => {
    setLoading(true);
    try {
      const res: any = await fetcher("/api/raydium-listener/start", {
        method: "POST",
      });
      if (res.success) {
        toast.success("Pool listener started");
        fetchStatus();
      } else {
        toast.error(res.message || "Failed to start listener");
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to start listener");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res: any = await fetcher("/api/raydium-listener/stop", {
        method: "POST",
      });
      if (res.success) {
        toast.success("Pool listener stopped");
        fetchStatus();
      } else {
        toast.error(res.message || "Failed to stop listener");
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to stop listener");
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateConfig = async () => {
    setLoading(true);
    try {
      const config = {
        minLiquiditySol,
        maxBuyTax,
        maxSellTax,
        requireMintDisabled,
        requireFreezeDisabled,
        requireLpLocked,
        autoBuyEnabled,
        autoBuyAmountSol,
      };

      const res: any = await fetcher("/api/raydium-listener/config", {
        method: "POST",
        body: JSON.stringify(config),
      });

      if (res.success) {
        toast.success("Configuration updated");
        fetchStatus();
      } else {
        toast.error(res.message || "Failed to update config");
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to update config");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-purple-500/20">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              🎧 Raydium Pool Listener
              {status?.isListening && (
                <Badge variant="default" className="bg-green-500">
                  LIVE
                </Badge>
              )}
              {status && !status.isListening && (
                <Badge variant="secondary">STOPPED</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Real-time detection of new Raydium pools with instant validation
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {status?.isListening ? (
              <Button onClick={handleStop} disabled={loading} variant="danger">
                Stop Listener
              </Button>
            ) : (
              <Button onClick={handleStart} disabled={loading}>
                Start Listener
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Stats */}
        {status && (
          <div className="grid grid-cols-2 gap-4 p-4 bg-secondary/50 rounded-lg">
            <div>
              <div className="text-sm text-muted-foreground">Status</div>
              <div className="text-2xl font-bold">
                {status.isListening ? "🟢 Active" : "🔴 Inactive"}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">
                Pools Detected
              </div>
              <div className="text-2xl font-bold">
                {status.detectedPoolsCount}
              </div>
            </div>
          </div>
        )}

        {/* Configuration */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Safety Filters</h3>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="minLiquidity">Min Liquidity (SOL)</Label>
              <Input
                id="minLiquidity"
                type="number"
                value={minLiquiditySol}
                onChange={(e) => setMinLiquiditySol(Number(e.target.value))}
                min={0}
                step={5}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxBuyTax">Max Buy Tax (%)</Label>
              <Input
                id="maxBuyTax"
                type="number"
                value={maxBuyTax}
                onChange={(e) => setMaxBuyTax(Number(e.target.value))}
                min={0}
                max={100}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxSellTax">Max Sell Tax (%)</Label>
              <Input
                id="maxSellTax"
                type="number"
                value={maxSellTax}
                onChange={(e) => setMaxSellTax(Number(e.target.value))}
                min={0}
                max={100}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="autoBuyAmount">Auto-Buy Amount (SOL)</Label>
              <Input
                id="autoBuyAmount"
                type="number"
                value={autoBuyAmountSol}
                onChange={(e) => setAutoBuyAmountSol(Number(e.target.value))}
                min={0}
                step={0.01}
                disabled={!autoBuyEnabled}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="mintDisabled">
                Require Mint Authority Disabled
              </Label>
              <Switch
                checked={requireMintDisabled}
                onCheckedChange={setRequireMintDisabled}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="freezeDisabled">
                Require Freeze Authority Disabled
              </Label>
              <Switch
                checked={requireFreezeDisabled}
                onCheckedChange={setRequireFreezeDisabled}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="lpLocked">Require LP Locked/Burned</Label>
              <Switch
                checked={requireLpLocked}
                onCheckedChange={setRequireLpLocked}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label
                htmlFor="autoBuy"
                className="font-semibold text-orange-500"
              >
                Enable Auto-Buy (CAREFUL!)
              </Label>
              <Switch
                checked={autoBuyEnabled}
                onCheckedChange={setAutoBuyEnabled}
              />
            </div>
          </div>

          <Button
            onClick={handleUpdateConfig}
            disabled={loading}
            className="w-full"
          >
            Update Configuration
          </Button>
        </div>

        {/* Info Box */}
        <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm">
          <h4 className="font-semibold mb-2">🧠 How It Works:</h4>
          <ul className="space-y-1 text-muted-foreground">
            <li>• Listens for new Raydium pool creation events in real-time</li>
            <li>
              • Validates LP size, token authorities, taxes, and honeypots
            </li>
            <li>
              • Auto-executes buy if all safety checks pass (when enabled)
            </li>
            <li>• Tracks all positions with live PnL updates</li>
            <li>
              • Only trades tokens that have already graduated from Pump.fun
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
