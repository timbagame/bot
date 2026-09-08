import { describe, expect, test } from "bun:test";
import {
  proveExpiredCreationAbsent,
  withCreationRebroadcast,
  getCreationRecoveryDelay,
  type RecoveryRpc,
} from "../src/utils/game-creation-recovery";

function fixture() {
  const blocks = new Map<number, any>();
  for (let slot = 10; slot <= 14; slot++)
    blocks.set(slot, {
      blockhash: `hash${slot}`,
      previousBlockhash: `hash${slot - 1}`,
      parentSlot: slot - 1,
      blockHeight: slot,
      signatures: [`unrelated${slot}`],
    });
  const input = {
    signature: "original",
    blockhash: "hash10",
    lastValidBlockHeight: 13,
    gameAddress: "game",
  };
  const rpc: RecoveryRpc = async (method, params) => {
    switch (method) {
      case "getGenesisHash":
        return "chain";
      case "getSlot":
        return 14;
      case "getBlock":
        return blocks.get(params[0] as number) ?? null;
      case "getSignatureStatuses":
        return { value: [null] };
      case "getAccountInfo":
        return { context: { slot: 14 }, value: null };
      case "isBlockhashValid":
        return { context: { slot: 14 }, value: false };
      default:
        throw new Error(method);
    }
  };
  return { input, rpc, blocks };
}

describe("Finalized creation absence proof", () => {
  test("requires every finalized block back to the exact transaction blockhash", async () => {
    const { input, rpc } = fixture();
    expect(await proveExpiredCreationAbsent(input, rpc, rpc)).toBe(true);
  });
  test("a completed and closed game cannot be charged again when status indexes miss it", async () => {
    const { input, rpc, blocks } = fixture();
    blocks.get(12).signatures.push(input.signature);
    expect(await proveExpiredCreationAbsent(input, rpc, rpc)).toBe(false);
  });
  for (const mutate of [
    (blocks: Map<number, any>) => blocks.delete(12),
    (blocks: Map<number, any>) => {
      blocks.get(12).signatures = undefined;
    },
    (blocks: Map<number, any>) => {
      blocks.get(12).blockhash = "other-fork";
    },
    (blocks: Map<number, any>) => {
      blocks.get(12).blockHeight = 1;
    },
    (blocks: Map<number, any>) => {
      blocks.get(12).parentSlot = 12;
    },
  ])
    test("incomplete or inconsistent history stays reserved", async () => {
      const { input, rpc, blocks } = fixture();
      mutate(blocks);
      expect(await proveExpiredCreationAbsent(input, rpc, rpc)).toBe(false);
    });
  for (const [method, result] of [
    ["getGenesisHash", "other-chain"],
    ["getBlock", { blockhash: "other-fork", blockHeight: 14 }],
    ["getSignatureStatuses", { value: [{ confirmationStatus: "finalized", err: null }] }],
    ["getSignatureStatuses", {}],
    ["getAccountInfo", { context: { slot: 14 }, value: { data: "exists" } }],
    ["getAccountInfo", { context: { slot: 12 }, value: null }],
    ["isBlockhashValid", { context: { slot: 14 }, value: true }],
  ])
    test(`witness disagreement/lag in ${method} blocks replacement`, async () => {
      const { input, rpc } = fixture();
      const witness: RecoveryRpc = (m, p) => (m === method ? Promise.resolve(result) : rpc(m, p));
      expect(await proveExpiredCreationAbsent(input, rpc, witness)).toBe(false);
    });
  test("RPC errors are not absence", async () => {
    const { input, rpc } = fixture();
    await expect(
      proveExpiredCreationAbsent(input, rpc, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
  test("expired height alone is insufficient if the actual blockhash is still valid", async () => {
    const { input, rpc } = fixture();
    input.lastValidBlockHeight = 14;
    expect(await proveExpiredCreationAbsent(input, rpc, rpc)).toBe(false);
  });
});

test("rebroadcasts before confirmation timeout and stops after success", async () => {
  let sends = 0;
  let confirm!: () => void;
  const pending = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  await withCreationRebroadcast(
    () => pending,
    async () => {
      sends++;
      if (sends === 2) confirm();
    },
    1,
  );
  expect(sends).toBe(2);
  await Bun.sleep(10);
  expect(sends).toBe(2);
});

test("rebroadcast failures do not cancel confirmation or delay its result", async () => {
  let sends = 0;
  let finished = false;
  let confirm!: () => void;
  const pending = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  await withCreationRebroadcast(
    () => pending,
    async () => {
      if (++sends === 1) throw new Error("RPC down");
      confirm();
      await Bun.sleep(5);
      finished = true;
    },
    1,
  );
  expect(sends).toBe(2);
  expect(finished).toBe(false);
  await Bun.sleep(10);
  expect(finished).toBe(true);
});

test("restart recovery locates the expiry anchor instead of scanning all later blocks", async () => {
  const { input, rpc, blocks } = fixture();
  for (let slot = 15; slot <= 1014; slot++)
    blocks.set(slot, {
      blockhash: `hash${slot}`,
      previousBlockhash: `hash${slot - 1}`,
      parentSlot: slot - 1,
      blockHeight: slot,
      signatures: [],
    });
  let reads = 0;
  const restarted: RecoveryRpc = async (method, params) => {
    if (method === "getSlot") return 1014;
    if (method === "getBlocks") return [...blocks.keys()];
    if (method === "getBlock") reads++;
    return rpc(method, params);
  };
  expect(await proveExpiredCreationAbsent(input, restarted, restarted)).toBe(true);
  expect(reads).toBeLessThan(25);
});

test("confirmation returns while a rebroadcast read is stalled and cancels its later send", async () => {
  let confirm!: () => void;
  let release!: () => void;
  let entered!: () => void;
  const confirmation = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let sends = 0;
  const result = withCreationRebroadcast(
    () => confirmation,
    async (signal) => {
      entered();
      await stalled;
      signal.throwIfAborted();
      sends++;
    },
    1,
  );
  await started;
  confirm();
  try {
    expect(
      await Promise.race([result.then(() => "confirmed"), Bun.sleep(30).then(() => "blocked")]),
    ).toBe("confirmed");
  } finally {
    release();
  }
  await Bun.sleep(5);
  expect(sends).toBe(0);
});

test("retry timing follows the current transaction lifetime and keeps failed notifications prompt", () => {
  const old = { state: "unknown", created_at: 1, attempts: 20 };
  expect(getCreationRecoveryDelay(old, 1_000_000)).toBe(900_000);
  expect(getCreationRecoveryDelay({ ...old, transaction_prepared_at: 999_000 }, 1_000_000)).toBe(
    3_000,
  );
  expect(getCreationRecoveryDelay({ ...old, state: "failed" }, 1_000_000)).toBe(3_000);
});
