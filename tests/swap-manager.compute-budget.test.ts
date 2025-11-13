import { describe, expect, test } from "bun:test";
import {
  ComputeBudgetProgram,
  Connection,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

const MNEMONIC =
  "test walk nut penalty hip pave soap entry language right filter choice";

describe("SwapManager compute budget helper", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = WalletManager.createForTest(MNEMONIC, {
    connection,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });
  const manager = new SwapManager(connection, wallet);

  test("caps compute unit limit when pump instructions add extra load", () => {
    const pumpInstruction = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.from([]),
    });

    const priceInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1,
    });

    const budgetInstructions = (manager as any).buildCompositeComputeBudgetInstructions(
      {
        pumpInstructions: [pumpInstruction],
        computeUnitLimit: 1_350_000,
        computePriceInstructions: [priceInstruction],
      }
    );

    expect(budgetInstructions[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    const limit = Buffer.from(budgetInstructions[0].data).readUInt32LE(1);
    expect(limit).toBe(1_400_000);
    expect(budgetInstructions[1]).toBe(priceInstruction);
  });
});
