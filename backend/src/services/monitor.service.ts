// backend/src/services/monitor.service.ts
import { getRaydiumQuote, executeRaydiumSwap } from "./raydium.service.js";
import dbService, { Position } from "./db.service.js";
import { getLogger } from "../utils/logger.js";
import notify from "./notifications/notify.service.js";
import { Server } from "socket.io";
import crypto from "crypto";
import { Connection, Commitment, PublicKey } from "@solana/web3.js";
import { checkAllEmergencyTriggers } from "./emergencyExit.service.js";

const log = getLogger("monitor");

/* ------------------------------------------------------------------
   CONFIG
------------------------------------------------------------------ */

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Global default TP/SL (percent *as decimal*; 0.1 = 10%)
const DEFAULT_TP_PCT = Number(process.env.TP_PCT ?? 0.1);
const DEFAULT_SL_PCT = Number(process.env.SL_PCT ?? 0.02);

// Use Helius RPC for monitoring token balances and position tracking
const SOLANA_RPC =
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL) ||
  process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
  "https://api.mainnet-beta.solana.com";

if (!SOLANA_RPC.startsWith("http")) {
  throw new Error("SOLANA_RPC_URL must start with http(s)://");
}

const commitment: Commitment =
  (process.env.SOLANA_COMMITMENT as Commitment) || "confirmed";

const connection = new Connection(SOLANA_RPC, commitment);

/* ------------------------------------------------------------------
   TYPES
------------------------------------------------------------------ */

// Position type now imported from db.service.ts
// Extended locally if needed for monitor-specific fields
type MonitorPosition = Position & {
  tpPct?: number; // take profit threshold (decimal: 0.15 = 15%)
  slPct?: number; // stop loss threshold (decimal: -0.05 = -5%)
  decimals?: number; // token decimals if stored
  highestPnlPct?: number; // highest profit % reached (for trailing)
  trailingActivated?: boolean; // whether trailing is active
};

// Trailing take-profit configuration - RULE 9
const TRAILING_ACTIVATION_PCT = Number(
  process.env.TRAILING_ACTIVATION_PCT ?? 0.15
); // 15% profit to activate trailing
const TRAILING_STOP_PCT = Number(process.env.TRAILING_STOP_PCT ?? 0.05); // 5% drop from peak to exit

/* ------------------------------------------------------------------
   MINT DECIMALS CACHE
------------------------------------------------------------------ */

const mintDecimalsCache = new Map<string, number>();

async function getMintDecimals(mint: string): Promise<number> {
  if (mintDecimalsCache.has(mint)) {
    return mintDecimalsCache.get(mint)!;
  }

  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed: any = info.value?.data;
    const decimals =
      parsed?.parsed?.info?.decimals ?? parsed?.info?.decimals ?? 9; // fallback

    const n = Number(decimals);
    const safeDecimals = Number.isFinite(n) ? n : 9;

    mintDecimalsCache.set(mint, safeDecimals);
    return safeDecimals;
  } catch (err: any) {
    log.warn(
      { mint, err: err?.message ?? String(err) },
      "Failed to fetch mint decimals; using 9"
    );
    mintDecimalsCache.set(mint, 9);
    return 9;
  }
}

/* ------------------------------------------------------------------
   CORE POSITION MONITOR
------------------------------------------------------------------ */

export function startPositionMonitor(
  io: Server,
  opts?: { intervalMs?: number }
) {
  const intervalMs = opts?.intervalMs ?? 5000;

  log.info(
    {
      intervalMs,
      DEFAULT_TP_PCT,
      DEFAULT_SL_PCT,
    },
    "Starting position monitor"
  );

  const tick = async () => {
    try {
      const positions: MonitorPosition[] = await dbService.getPositions();

      for (const pos of positions) {
        try {
          const tokenMint = pos.token;
          if (!tokenMint) continue;
          if (!pos.netSol || pos.netSol <= 0) continue;

          // Per-position overrides if you ever add them to DB
          const tpPct =
            typeof pos.tpPct === "number" ? pos.tpPct : DEFAULT_TP_PCT;
          const slPct =
            typeof pos.slPct === "number" ? pos.slPct : DEFAULT_SL_PCT;

          // Fetch decimals (cached)
          const decimals =
            typeof pos.decimals === "number"
              ? pos.decimals
              : await getMintDecimals(tokenMint);
          const base = 10 ** decimals;

          // avgBuyPrice = SOL per token (approx). If missing, fall back to a tiny value.
          const avgBuy =
            typeof pos.avgBuyPrice === "number" && pos.avgBuyPrice > 0
              ? pos.avgBuyPrice
              : Number(process.env.FALLBACK_AVG_PRICE_SOL ?? 0.000_001);

          // Estimated token quantity = total SOL exposure / avg buy price
          const estTokenQty = pos.netSol / avgBuy;
          if (!Number.isFinite(estTokenQty) || estTokenQty <= 0) {
            log.debug(
              { tokenMint, netSol: pos.netSol, avgBuy },
              "Skipping position: invalid estTokenQty"
            );
            continue;
          }

          // Full position in token base units
          const fullAmountBase = Math.floor(estTokenQty * base);
          if (!fullAmountBase || fullAmountBase <= 0) {
            log.debug(
              { tokenMint, estTokenQty, decimals },
              "Skipping position: zero base amount"
            );
            continue;
          }

          // Use 10% of position (or a safe minimum) to probe price via Raydium
          const probeAmountBase = Math.max(
            Math.floor(fullAmountBase / 10),
            Math.floor(base / 1000) // e.g. 0.001 token
          );

          const quote = await getRaydiumQuote(
            tokenMint,
            SOL_MINT,
            probeAmountBase,
            1
          );
          if (!quote?.outAmount) continue;

          const outSolForProbe = Number(quote.outAmount) / 1e9;
          if (!outSolForProbe || outSolForProbe <= 0) continue;

          const probeTokenQty = probeAmountBase / base;
          const currentPrice = outSolForProbe / probeTokenQty; // SOL per token

          const pnlPercent = (currentPrice - avgBuy) / avgBuy;

          // Update highest PnL for trailing stop - RULE 9
          const highestPnl = pos.highestPnlPct ?? pnlPercent;
          const newHighest = Math.max(highestPnl, pnlPercent);

          // Activate trailing if profit exceeds activation threshold
          const trailingActive =
            pos.trailingActivated || newHighest >= TRAILING_ACTIVATION_PCT;

          // Check trailing stop exit condition
          const trailingTriggered =
            trailingActive && newHighest - pnlPercent >= TRAILING_STOP_PCT;

          // Update position with new highest PnL and trailing status
          if (
            newHighest > highestPnl ||
            trailingActive !== pos.trailingActivated
          ) {
            await dbService.updatePositionMetadata(tokenMint, {
              highestPnlPct: newHighest,
              trailingActivated: trailingActive,
            });

            // Emit trailing stop status to frontend
            io.emit("position:trailingUpdate", {
              token: tokenMint,
              currentPnlPct: pnlPercent,
              highestPnlPct: newHighest,
              trailingActivated: trailingActive,
              trailingStopPct: TRAILING_STOP_PCT,
              trailingActivationPct: TRAILING_ACTIVATION_PCT,
              drawdownFromPeak: trailingActive ? newHighest - pnlPercent : 0,
              timestamp: Date.now(),
            });
          }

          // ✨ RULE 10: EMERGENCY EXIT CHECKS (CRITICAL - CHECK FIRST!)
          const emergencyCheck = await checkAllEmergencyTriggers(
            tokenMint,
            currentPrice,
            undefined, // poolAddress - would need to store this
            undefined // creatorAddress - would need to store this
          );

          if (emergencyCheck.shouldExit) {
            log.error(
              {
                tokenMint,
                reason: emergencyCheck.criticalReason,
                triggers: emergencyCheck.triggers,
              },
              "🚨 EMERGENCY EXIT TRIGGERED - SELLING ALL IMMEDIATELY!"
            );

            // Emergency sell ALL tokens immediately
            const useRealSwap = process.env.USE_REAL_SWAP === "true";
            const backendWallet =
              process.env.BACKEND_RECEIVER_WALLET ||
              process.env.SERVER_PUBLIC_KEY ||
              "";

            if (useRealSwap && backendWallet) {
              const emergencySwap = await executeRaydiumSwap({
                inputMint: tokenMint,
                outputMint: SOL_MINT,
                amount: fullAmountBase,
                userPublicKey: backendWallet,
                slippage: 10, // High slippage for emergency
              });

              if (emergencySwap.success) {
                const emergencyTrade = {
                  id: crypto.randomUUID(),
                  type: "sell" as const,
                  token: tokenMint,
                  inputMint: tokenMint,
                  outputMint: SOL_MINT,
                  amount: fullAmountBase,
                  price: currentPrice,
                  pnl: pnlPercent,
                  wallet: backendWallet,
                  simulated: false,
                  signature: emergencySwap.signature ?? null,
                  timestamp: new Date(),
                };

                await dbService.addTrade(emergencyTrade);

                io.emit("tradeFeed", {
                  ...emergencyTrade,
                  auto: true,
                  reason: "emergency_exit",
                  exitReason: emergencyCheck.criticalReason,
                  emergency: true,
                });

                log.info(
                  {
                    tokenMint,
                    reason: emergencyCheck.criticalReason,
                    signature: emergencySwap.signature,
                  },
                  "🚨 Emergency exit completed"
                );
              } else {
                log.error(
                  {
                    tokenMint,
                    error: emergencySwap.error,
                  },
                  "Emergency exit swap failed!"
                );
              }
            }

            continue; // Skip normal TP/SL checks - emergency handled
          }

          // ✨ RULE 9: TIERED PROFIT TARGETS (30% at +40%, +80%, +150%)
          const remainingPct = pos.remainingPct ?? 100; // Track remaining position %

          // Check for tiered profit target triggers
          let shouldSellTiered = false;
          let sellPercent = 0;
          let tierReason = "";

          if (!pos.soldAt40 && pnlPercent >= 0.4 && remainingPct > 0) {
            shouldSellTiered = true;
            sellPercent = 30;
            tierReason = "Tier 1: +40% profit";
            await dbService.updatePositionMetadata(tokenMint, {
              soldAt40: true,
              remainingPct: remainingPct - 30,
            });
          } else if (!pos.soldAt80 && pnlPercent >= 0.8 && remainingPct > 0) {
            shouldSellTiered = true;
            sellPercent = 30;
            tierReason = "Tier 2: +80% profit";
            await dbService.updatePositionMetadata(tokenMint, {
              soldAt80: true,
              remainingPct: remainingPct - 30,
            });
          } else if (!pos.soldAt150 && pnlPercent >= 1.5 && remainingPct > 0) {
            shouldSellTiered = true;
            sellPercent = 30;
            tierReason = "Tier 3: +150% profit";
            await dbService.updatePositionMetadata(tokenMint, {
              soldAt150: true,
              remainingPct: remainingPct - 30,
            });
          }

          // Execute tiered sell if triggered
          if (shouldSellTiered) {
            const sellAmountBase = Math.floor(
              fullAmountBase * (sellPercent / 100)
            );

            log.info(
              {
                tokenMint,
                pnlPercent,
                sellPercent,
                tierReason,
                remainingPct: remainingPct - sellPercent,
              },
              `🎯 Tiered profit target hit: ${tierReason}. Selling ${sellPercent}%`
            );

            const useRealSwap = process.env.USE_REAL_SWAP === "true";

            if (useRealSwap) {
              const backendWallet =
                process.env.BACKEND_RECEIVER_WALLET ||
                process.env.SERVER_PUBLIC_KEY ||
                "";

              if (backendWallet) {
                const tieredSwap = await executeRaydiumSwap({
                  inputMint: tokenMint,
                  outputMint: SOL_MINT,
                  amount: sellAmountBase,
                  userPublicKey: backendWallet,
                  slippage: Number(process.env.DEFAULT_SLIPPAGE_PCT ?? 1),
                });

                if (tieredSwap.success) {
                  const tieredTrade = {
                    id: crypto.randomUUID(),
                    type: "sell" as const,
                    token: tokenMint,
                    inputMint: tokenMint,
                    outputMint: SOL_MINT,
                    amount: sellAmountBase,
                    price: currentPrice,
                    pnl: pnlPercent,
                    wallet: backendWallet,
                    simulated: false,
                    signature: tieredSwap.signature ?? null,
                    timestamp: new Date(),
                  };

                  await dbService.addTrade(tieredTrade);

                  io.emit("tradeFeed", {
                    ...tieredTrade,
                    auto: true,
                    reason: "tiered_profit",
                    exitReason: tierReason,
                    sellPercent,
                    remainingPct: remainingPct - sellPercent,
                  });

                  log.info(
                    {
                      tokenMint,
                      tierReason,
                      sellPercent,
                      signature: tieredSwap.signature,
                    },
                    "✅ Tiered profit sell executed"
                  );
                }
              }
            }
          }

          // Check trailing stop for LAST 10% of position
          const isLastTenPercent = remainingPct <= 10;
          const trailingStopForFinal =
            isLastTenPercent &&
            trailingActive &&
            newHighest - pnlPercent >= TRAILING_STOP_PCT;

          // Check TP/SL triggers (including trailing for final 10%)
          if (
            pnlPercent <= -slPct || // Stop loss
            (isLastTenPercent && trailingStopForFinal) // Trailing stop for last 10%
          ) {
            const exitReason = trailingStopForFinal
              ? `Trailing stop on final 10% (peak: ${(newHighest * 100).toFixed(
                  1
                )}%, current: ${(pnlPercent * 100).toFixed(1)}%)`
              : `Stop loss (${(pnlPercent * 100).toFixed(1)}%)`;
            log.info(
              {
                tokenMint,
                pnlPercent,
                avgBuy,
                currentPrice,
                slPct,
                highestPnl: newHighest,
                trailingActive,
                remainingPct,
                exitReason,
              },
              `Position exit triggered: ${exitReason}. Executing auto-sell.`
            );

            const useRealSwap = process.env.USE_REAL_SWAP === "true";

            // Calculate remaining position to sell (based on remainingPct)
            const sellAmountBase = Math.floor(
              fullAmountBase * (remainingPct / 100)
            );

            let swapRes:
              | { success: true; signature?: string }
              | { success: false; error?: string };

            if (useRealSwap) {
              const backendWallet =
                process.env.BACKEND_RECEIVER_WALLET ||
                process.env.SERVER_PUBLIC_KEY ||
                "";

              if (!backendWallet) {
                log.error(
                  { tokenMint },
                  "USE_REAL_SWAP=true but BACKEND_RECEIVER_WALLET / SERVER_PUBLIC_KEY is not set"
                );
                swapRes = {
                  success: false,
                  error: "Missing backend wallet for auto-sell",
                };
              } else {
                // Verify balance before selling (should have tokens)
                log.info(
                  {
                    tokenMint,
                    amount: sellAmountBase,
                    remainingPct,
                  },
                  "Executing final auto-sell"
                );
                swapRes = await executeRaydiumSwap({
                  inputMint: tokenMint,
                  outputMint: SOL_MINT,
                  amount: sellAmountBase,
                  userPublicKey: backendWallet,
                  slippage: Number(process.env.DEFAULT_SLIPPAGE_PCT ?? 1),
                });
              }
            } else {
              swapRes = {
                success: true,
                signature: `sim-sell-${Date.now()}`,
              };
            }

            if (!swapRes.success) {
              log.error(
                {
                  tokenMint,
                  error: swapRes.error,
                },
                "Auto-sell swap failed"
              );

              // Send error notification
              notify
                .notifyError({
                  source: "position-monitor",
                  message: `Auto-sell failed for ${tokenMint}`,
                  details: { error: swapRes.error, pnlPercent, tpPct, slPct },
                })
                .catch(() => {});

              continue;
            }

            // Build trade record in DB format
            const tradeRecord = {
              id: crypto.randomUUID(),
              type: "sell" as const,
              token: tokenMint,
              inputMint: tokenMint,
              outputMint: SOL_MINT,
              amount: sellAmountBase, // Sell only remaining position
              price: currentPrice, // SOL per token
              pnl: pnlPercent, // decimal (0.12 = +12%)
              wallet:
                process.env.BACKEND_RECEIVER_WALLET ||
                process.env.SERVER_PUBLIC_KEY ||
                "",
              simulated: !useRealSwap,
              signature: swapRes.signature ?? null,
              timestamp: new Date(),
            };

            // Update position metadata to mark as fully exited
            await dbService.updatePositionMetadata(tokenMint, {
              remainingPct: 0,
            });

            // Persist and let db.service compute updated stats
            const saved = await dbService.addTrade(tradeRecord);

            // Emit rich tradeFeed event for frontend PnL
            io.emit("tradeFeed", {
              id: saved.id,
              type: saved.type,
              token: saved.token,
              amount: saved.amountLamports,
              amountSol: saved.amountSol,
              price: saved.price,
              pnl: saved.pnl, // decimal
              pnlSol: saved.pnlSol,
              simulated: saved.simulated,
              signature: saved.signature,
              timestamp: saved.timestamp,
              auto: true,
              reason: trailingStopForFinal
                ? "trailing_stop_final"
                : pnlPercent <= -slPct
                ? "stop_loss"
                : "final_exit",
              exitReason: exitReason,
              sellPercent: remainingPct,
              remainingPct: 0,
              highestPnlPct: trailingStopForFinal ? newHighest : undefined,
            });

            log.info(
              {
                tokenMint,
                id: saved.id,
                reason: pnlPercent >= tpPct ? "TP" : "SL",
              },
              "Auto-sell executed & broadcast"
            );

            // Send notification (build object with only defined properties)
            const notifyPayload: {
              id: string;
              type: "sell";
              token: string;
              amountSol: number;
              price?: number;
              pnl?: number;
              signature?: string | null;
              simulated?: boolean;
            } = {
              id: saved.id,
              type: "sell",
              token: saved.token,
              amountSol: saved.amountSol,
            };
            if (saved.price !== undefined) notifyPayload.price = saved.price;
            if (saved.pnl !== undefined) notifyPayload.pnl = saved.pnl;
            if (saved.signature !== undefined)
              notifyPayload.signature = saved.signature;
            if (saved.simulated !== undefined)
              notifyPayload.simulated = saved.simulated;

            notify
              .notifyTrade(notifyPayload)
              .catch((notifyErr) =>
                log.warn(
                  { err: notifyErr },
                  "Failed to send trade notification"
                )
              );
          }
        } catch (innerErr: any) {
          log.error(
            {
              err: innerErr?.message ?? String(innerErr),
            },
            "Monitor inner loop error"
          );

          // Send error notification for critical monitoring failures
          notify
            .notifyError({
              source: "position-monitor",
              message: "Position monitoring error",
              details: {
                error: innerErr?.message ?? String(innerErr),
                position: pos,
              },
            })
            .catch(() => {});
        }
      }
    } catch (err: any) {
      log.error(
        { err: err?.message ?? String(err) },
        "Position monitor tick failed"
      );
    }
  };

  const timer = setInterval(tick, intervalMs);

  // Run one tick immediately on startup
  tick().catch((e) =>
    log.warn(
      { err: (e as any)?.message ?? String(e) },
      "Initial monitor tick error"
    )
  );

  // Allow caller to stop monitor
  return () => clearInterval(timer);
}
