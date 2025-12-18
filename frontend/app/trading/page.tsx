"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Card } from "@components/ui/card";
import TradingConfigPanel from "@components/trading/trading-config";
import LiveFeed from "@components/trading/live-feed";
import TokenTable from "@app/trading/token-table";
import StatsPanel from "@app/trading/stats-panel";
import ActionsBar from "@app/trading/actions-bar";
// import { SocialFilter } from "@app/trading/social-filter"; // Disabled - backend endpoint not implemented
import PerformanceChart from "@components/trading/performance-chart";
import { NewTokens } from "@app/trading/new-tokens";
import TradeSummary from "@components/trading/trade-summary"; // ✅ imported from ui version
import TradeHistory from "@components/trading/trade-history";
import { useAutoTrade } from "@hooks/useAutoTrade";
import { usePortfolio } from "@hooks/usePortfolio";
import { TraderConfigModal } from "@components/trading/trader-config-modal";
import { RiskManagementPanel } from "@components/trading/risk-management-panel";
import { ValidationStatus } from "@components/trading/ValidationStatus";
import { useValidation } from "@hooks/useValidation";
import { useConfig } from "@hooks/useConfig";
import { Settings } from "lucide-react";
import { useSocket } from "@hooks/useSocket";
import { toast } from "react-hot-toast";
import { EmergencyAlert } from "@components/trading/EmergencyAlert";
import { StoredTokenCheckerStatus } from "@components/trading/StoredTokenCheckerStatus";

const fadeIn = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay },
});

export default function TradingDashboard() {
  // Initialize auto-trade hook to listen for opportunities
  useAutoTrade();

  // Initialize portfolio tracking (wallet balance → portfolio value)
  usePortfolio();

  // Initialize socket connection for pool monitoring notifications
  const { lastMessage } = useSocket();

  // Get selected token for validation
  const { selectedToken } = useConfig();

  // Initialize validation hook
  const { validation } = useValidation(selectedToken);

  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);

  // Listen for pool monitoring events
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.event === "poolAvailable") {
      const { tokenMint, message } = lastMessage.payload;
      const shortMint = tokenMint.slice(0, 8) + "...";
      toast.success(`🎉 ${message || `Pool available for ${shortMint}!`}`, {
        duration: 8000,
        position: "top-right",
      });
    }

    if (lastMessage.event === "poolMonitorTimeout") {
      const { tokenMint, message } = lastMessage.payload;
      const shortMint = tokenMint.slice(0, 8) + "...";
      toast.error(
        `⏱️ ${
          message ||
          `Monitoring timeout for ${shortMint}. Pool not available after 10 minutes.`
        }`,
        {
          duration: 6000,
          position: "top-right",
        }
      );
    }
  }, [lastMessage]);

  return (
    <div className="container mx-auto px-4 py-8 space-y-10">
      {/* Emergency Alert Notifications */}
      <EmergencyAlert />

      {/* ========================== HEADER ========================== */}
      <motion.div {...fadeIn(0.1)}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-primary mb-2">
              ArchAngel Trading Dashboard
            </h1>
            <p className="text-base-content/60">
              Track trades, monitor profit, and manage your Solana trading setup
              in real time.
            </p>
          </div>
          <button
            onClick={() => setIsConfigModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            suppressHydrationWarning
          >
            <Settings className="w-5 h-5" />
            Trading Settings
          </button>
        </div>
      </motion.div>

      {/* Trader Config Modal */}
      <TraderConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
      />

      {/* ========================== SUMMARY (Animated) ========================== */}
      <motion.div {...fadeIn(0.2)}>
        <TradeSummary />
      </motion.div>

      {/* ========================== GRID LAYOUT ========================== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT COLUMN */}
        <motion.div {...fadeIn(0.3)} className="space-y-6">
          <Card className="p-4">
            <TradingConfigPanel />
          </Card>

          {/* Validation Status Panel - NEW */}
          {selectedToken && <ValidationStatus validation={validation} />}

          {/* Stored Token Checker Status */}
          <StoredTokenCheckerStatus />

          {/* Risk Management Panel */}
          <RiskManagementPanel />

          {/* Social Filter temporarily disabled - backend endpoint not implemented */}
          {/* <Card className="p-4">
            <SocialFilter />
          </Card> */}
        </motion.div>

        {/* CENTER COLUMN */}
        <motion.div {...fadeIn(0.4)} className="space-y-6">
          <Card className="p-4">
            <StatsPanel />
          </Card>

          <Card className="p-4">
            <TokenTable />
          </Card>

          <Card className="p-4">
            <LiveFeed />
          </Card>
        </motion.div>

        {/* RIGHT COLUMN */}
        <motion.div {...fadeIn(0.5)} className="space-y-6">
          <Card className="p-4">
            <NewTokens />
          </Card>

          <Card className="p-4">
            <PerformanceChart />
          </Card>
          <Card className="p-4">
            <TradeHistory />
          </Card>
        </motion.div>
      </div>

      {/* ========================== MANUAL ACTIONS ========================== */}
      <motion.div {...fadeIn(0.6)}>
        <ActionsBar />
      </motion.div>
    </div>
  );
}
