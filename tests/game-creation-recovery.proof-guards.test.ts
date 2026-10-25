import { describe, expect, test } from "bun:test";
import {
  proveExpiredCreationAbsent,
  type CreationProofCheckpoint,
  type RecoveryRpc,
} from "../src/utils/game-creation-recovery";

const input = {
  signature: "original",
  blockhash: "hash10",
  lastValidBlockHeight: 13,
  gameAddress: "game",
};

function chain(slotFrom: number, slotTo: number) {
  const blocks = new Map<number, any>();
  for (let slot = slotFrom; slot <= slotTo; slot++)
    blocks.set(slot, {
      blockhash: `hash${slot}`,
      previousBlockhash: `hash${slot - 1}`,
      parentSlot: slot - 1,
      blockHeight: slot,
      signatures: [`unrelated${slot}`],
    });
  return blocks;
}

function rpcFor(blocks: Map<number, any>, tip: number, overrides: Record<string, unknown> = {}) {
  const rpc: RecoveryRpc = async (method, params) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case "getGenesisHash":
        return "chain";
      case "getSlot":
        return tip;
      case "getBlock":
        return blocks.get(params[0] as number) ?? null;
      case "getSignatureStatuses":
        return { value: [null] };
      case "getAccountInfo":
        return { context: { slot: tip }, value: null };
      case "isBlockhashValid":
        return { context: { slot: tip }, value: false };
      default:
        throw new Error(method);
    }
  };
  return rpc;
}

describe("restart jump to the expiry anchor", () => {
  // Tip is far enough past expiry (distance > 64) that the slot list is requested.
  const blocks = chain(10, 1_014);

  for (const [label, slots] of [
    ["not an array", { slots: [] }],
    ["empty", []],
    ["containing a non-integer slot", [1_000.5]],
    ["containing a slot after the tip", [1_000, 2_000]],
    ["not strictly increasing", [1_000, 1_000]],
    ["decreasing", [1_001, 1_000]],
  ] as const)
    test(`a slot list that is ${label} leaves the creation unproven`, async () => {
      const rpc = rpcFor(blocks, 1_014, { getBlocks: slots });
      expect(await proveExpiredCreationAbsent(input, rpc, rpc)).toBe(false);
    });
});

describe("resuming from a saved checkpoint", () => {
  const key = "game:original:hash10:13";
  const checkpoint: CreationProofCheckpoint = {
    key,
    genesis: "chain",
    anchor: { slot: 14, hash: "hash14", height: 14 },
    cursor: { slot: 12, hash: "hash12", height: 12 },
    checkedBlocks: 2,
  };

  test("resumes at the cursor when the saved chain still matches", async () => {
    const blocks = chain(10, 14);
    const rpc = rpcFor(blocks, 14);
    const saved: number[] = [];
    expect(
      await proveExpiredCreationAbsent(input, rpc, rpc, {
        checkpoint,
        save: (next) => saved.push(next.checkedBlocks),
      }),
    ).toBe(true);
    // Only the blocks after the cursor were walked: 12 -> 11 -> 10.
    expect(saved).toEqual([3, 4]);
  });

  test("a cursor block that no longer matches the saved hash is not trusted", async () => {
    const blocks = chain(10, 14);
    blocks.get(12).blockhash = "reorged-hash12";
    const rpc = rpcFor(blocks, 14);
    expect(await proveExpiredCreationAbsent(input, rpc, rpc, { checkpoint, save: () => {} })).toBe(
      false,
    );
  });

  test("a missing cursor block is not trusted", async () => {
    const blocks = chain(10, 14);
    blocks.delete(12);
    const rpc = rpcFor(blocks, 14);
    expect(await proveExpiredCreationAbsent(input, rpc, rpc, { checkpoint, save: () => {} })).toBe(
      false,
    );
  });
});
