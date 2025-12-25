import { getConnection } from "./solana.service.js";
import { PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("onchainEventWatcher");

/* =========================
   VERIFIED PROGRAM IDS
========================= */

const PROGRAM_IDS = {
  raydium: new Set([
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // AMM v4
    "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h", // AMM v3
    "CAMMCzo5YL8w4VFF8vH2F6GJx9d9yFhWz7tZrZ6R9dM", // CLMM
  ]),

  orca: new Set([
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Whirlpool
    "9W959DqEETiGZocYWCQPaJ6kYd3f7T6hC6n9Rdt2vJtZ", // Legacy swap
  ]),

  // ⚠️ Meteora placeholder kept but will be safely skipped
  meteora: new Set(["MeteoraDLMM1111111111111111111111111111111"]),

  pumpfun: new Set(["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]),
};

const ALL_PROGRAM_IDS = new Set(
  Object.values(PROGRAM_IDS).flatMap((s) => [...s])
);

/* =========================
   SAFETY UTILITIES (OPTION B)
========================= */

function safePublicKey(id: string, context = "program"): PublicKey | null {
  try {
    return new PublicKey(id);
  } catch {
    log.warn(`⚠️ Invalid ${context} ID skipped: ${id}`);
    return null;
  }
}

function isTargetProgram(programId: string) {
  return ALL_PROGRAM_IDS.has(programId);
}

function extractAccounts(ix: any, tx: ParsedTransactionWithMeta) {
  if (
    "accounts" in ix &&
    Array.isArray(ix.accounts) &&
    tx.transaction.message.accountKeys
  ) {
    return ix.accounts
      .map((i: number) => {
        const keys = tx.transaction.message.accountKeys;
        if (keys && keys[i] && keys[i].pubkey) {
          return keys[i].pubkey.toBase58();
        }
        return undefined;
      })
      .filter((a: string | undefined) => !!a);
  }
  return [];
}

/* =========================
   STARTUP VALIDATION
========================= */

for (const [dex, ids] of Object.entries(PROGRAM_IDS)) {
  ids.forEach((id) => {
    if (!safePublicKey(id, `${dex} program`)) {
      log.warn(`⚠️ ${dex} program disabled: ${id}`);
    }
  });
}

/* =========================
   TOKEN MINT LISTENER
========================= */

export function listenForInitializeMint(
  onNewToken: (mint: string, slot: number) => void
) {
  const conn = getConnection();
  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );

  conn.onLogs(
    TOKEN_PROGRAM_ID,
    async ({ signature }, ctx) => {
      const tx = await conn.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (!tx) return;

      for (const ix of tx.transaction.message.instructions) {
        if ("parsed" in ix && ix.parsed?.type === "initializeMint") {
          const mint = ix.parsed.info.mint;
          log.info(`🆕 SPL Mint: ${mint} @ slot ${ctx.slot}`);
          onNewToken(mint, ctx.slot);
        }
      }
    },
    "confirmed"
  );
}

/* =========================
   POOL / LIQUIDITY LISTENER
========================= */

export function listenForPoolEvents(
  onNewPool: (info: {
    dex: string;
    programId: string;
    pool: string;
    mints: string[];
    slot: number;
  }) => void
) {
  const conn = getConnection();

  ALL_PROGRAM_IDS.forEach((programId) => {
    const pubkey = safePublicKey(programId, "DEX program");
    if (!pubkey) return;

    conn.onLogs(
      pubkey,
      async ({ signature }, ctx) => {
        const tx = await conn.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });

        if (!tx || !tx.meta) return;

        for (const ix of tx.transaction.message.instructions) {
          let pid = "";

          if ("programId" in ix && ix.programId) {
            if (typeof ix.programId === "string") {
              pid = ix.programId;
            } else if (typeof ix.programId.toBase58 === "function") {
              pid = ix.programId.toBase58();
            }
          }

          if (!isTargetProgram(pid)) continue;

          const accounts = extractAccounts(ix, tx);
          if (!accounts.length) continue;

          const pool = accounts[0];
          const feePayer =
            tx.transaction.message.accountKeys?.[0]?.pubkey?.toBase58?.() ?? "";

          const mints = accounts.filter(
            (a: string) => a !== pool && a !== feePayer
          );

          const dex = PROGRAM_IDS.raydium.has(pid)
            ? "raydium"
            : PROGRAM_IDS.orca.has(pid)
            ? "orca"
            : PROGRAM_IDS.meteora.has(pid)
            ? "meteora"
            : "pumpfun";

          log.info(`🚀 [${dex}] Pool detected → ${pool} @ slot ${ctx.slot}`);

          onNewPool({
            dex,
            programId: pid,
            pool,
            mints,
            slot: ctx.slot,
          });
        }
      },
      "confirmed"
    );
  });
}

/* =========================
   EXPORT
========================= */

export default {
  listenForInitializeMint,
  listenForPoolEvents,
};
