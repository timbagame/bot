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

    const budgetInstructions = (
      manager as any
    ).buildCompositeComputeBudgetInstructions({
      pumpInstructions: [pumpInstruction],
      computeUnitLimit: 1_350_000,
    });

    expect(
      budgetInstructions[0].programId.equals(ComputeBudgetProgram.programId)
    ).toBe(true);
    const limit = Buffer.from(budgetInstructions[0].data).readUInt32LE(1);
    expect(limit).toBe(600_000);
    expect(
      budgetInstructions[1].programId.equals(ComputeBudgetProgram.programId)
    ).toBe(true);
    const priceData = Buffer.from(budgetInstructions[1].data);
    expect(priceData[0]).toBe(3);
    const microLamports = priceData.readBigUInt64LE(1);
    expect(Number(microLamports)).toBe(1);
  });
});
