import {
  TradingStrategy,
  StrategyContext,
  StrategyResult,
} from "./strategyEngine.js";

// Sniper: Buys immediately on pool creation or first liquidity, with optional filters
export const sniperStrategy: TradingStrategy = {
  name: "sniper",
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    // Example: Only buy if pool just created and liquidity > threshold
    const { currentLiquidity, tokenMeta } = context;
    const minLiquidity = 1; // 1 SOL (configurable)
    if (tokenMeta?.justLaunched && currentLiquidity >= minLiquidity) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Sniper: Pool just launched with ${currentLiquidity} SOL`,
      };
    }
    return {
      shouldBuy: false,
      shouldSell: false,
      reason: "Not a sniper opportunity",
    };
  },
};
