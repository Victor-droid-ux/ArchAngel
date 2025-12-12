import { ComputeBudgetProgram } from "@solana/web3.js";

/* ----------------------------------------------------
   Build priority fee instructions
   - priorityMicroLamports: e.g. 30,000 (0.00003 SOL)
---------------------------------------------------- */
export function buildPriorityFeeIxs(priorityMicroLamports: number = 30000) {
  const ixs = [];

  // Increase compute budget to avoid CU exhaustion during swaps
  ixs.push(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000, // safe for Raydium swaps
    })
  );

  // Add priority fee
  ixs.push(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityMicroLamports,
    })
  );

  return ixs;
}
