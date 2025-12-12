import { Router } from "express";
import dbService from "../services/db.service.js";
import axios from "axios";

const router = Router();

const TOKENLIST_URL =
  process.env.JUPITER_TOKENLIST_URL || "https://tokens.jup.ag/tokens"; // fallback official

router.get("/", async (_, res) => {
  try {
    const positions = await dbService.getPositions();
    if (!positions.length) {
      return res.json({ success: true, positions: [] });
    }

    // Fetch Jupiter token list once per request
    const { data: tokens } = await axios.get(TOKENLIST_URL);

    const enriched = positions.map((p) => {
      const match = tokens.find(
        (t: any) => t.address === p.token || t.symbol?.toUpperCase() === p.token
      );

      const price = Number(match?.price ?? 0);

      const currentValue = price * p.netSol;
      const buyValue = (p.avgBuyPrice || 0) * p.netSol;

      const unrealizedPnlSol =
        p.avgBuyPrice && price ? currentValue - buyValue : 0;

      const unrealizedPnlPct =
        p.avgBuyPrice && price ? (price - p.avgBuyPrice) / p.avgBuyPrice : 0;

      return {
        ...p,
        name: match?.name ?? p.token,
        mint: match?.address ?? p.token,
        currentPrice: price,
        unrealizedPnlSol,
        unrealizedPnlPct,
      };
    });

    res.json({
      success: true,
      positions: enriched,
    });
  } catch (err: any) {
    console.error("Positions API error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed fetching positions",
    });
  }
});

export default router;
