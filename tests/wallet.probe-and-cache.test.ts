import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import { WalletManager } from "../src/utils/wallet";
import { stubInstantTimers } from "./helpers/timers";

const MNEMONIC = process.env.MNEMONIC!;

let instantTimers: ReturnType<typeof stubInstantTimers>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  instantTimers = stubInstantTimers();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  instantTimers.restore();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const walletWith = (connection: Record<string, unknown>) =>
  WalletManager.createForTest(MNEMONIC, {
    connection: { rpcEndpoint: "http://localhost:8899", ...connection } as any,
  });

const messages = (spy: ReturnType<typeof spyOn>): string[] =>
  spy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));

describe("keypair cache eviction", () => {
  test("evicts the least recently used keypair once over capacity", async () => {
    const wallet = walletWith({});
    wallet.__test_setKeypairCacheConfig({ capacity: 2, timeNow: () => 1_000 });
    const cache = (wallet as any).keypairCache;
    const [a, b, c] = await Promise.all([
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
    ]);

    cache.set("a", a);
    cache.set("b", b);
    expect(cache.get("a")).toBe(a); // touching "a" makes "b" the oldest entry
    cache.set("c", c);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(a);
    expect(cache.get("c")).toBe(c);
  });

  test("a zero-or-negative capacity cache drains instead of looping forever", async () => {
    const wallet = walletWith({});
    wallet.__test_setKeypairCacheConfig({ capacity: -1 });
    const cache = (wallet as any).keypairCache;

    cache.set("a", await Keypair.generate());

    expect(cache.get("a")).toBeUndefined();
  });
});

describe("post-timeout transaction probe", () => {
  const probe = (wallet: WalletManager, signature = "SIGPROBE") =>
    (wallet as any).probeTransactionAfterTimeout(signature) as Promise<
      "found" | "failed" | "missing"
    >;

  test("reports a failed transaction found by getTransaction", async () => {
    const wallet = walletWith({
      getTransaction: async () => ({ meta: { err: { InstructionError: [0, "Custom"] } } }),
      getSignatureStatus: async () => {
        throw new Error("must not be reached");
      },
    });

    expect(await probe(wallet)).toBe("failed");
    expect(messages(errorSpy).some((m) => m.includes("getTransaction reports failure"))).toBe(true);
  });

  test("gives up on getTransaction after a non-retryable error and falls through to the status check", async () => {
    let statusCalls = 0;
    let txCalls = 0;
    const wallet = walletWith({
      getTransaction: async () => {
        txCalls += 1;
        throw new Error("invalid params");
      },
      getSignatureStatus: async () => {
        statusCalls += 1;
        return { value: null };
      },
    });

    expect(await probe(wallet)).toBe("missing");
    expect(txCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(
      messages(warnSpy).some((m) =>
        m.includes("getTransaction probe for SIGPROBE failed: invalid params"),
      ),
    ).toBe(true);
  });

  test("retries a rate limited getTransaction with the configured delay", async () => {
    let txCalls = 0;
    const wallet = walletWith({
      getTransaction: async () => {
        txCalls += 1;
        if (txCalls < 3) throw new Error("429 Too Many Requests");
        return { meta: { err: null } };
      },
      getSignatureStatus: async () => ({ value: null }),
    });

    expect(await probe(wallet)).toBe("found");
    expect(txCalls).toBe(3);
    expect(instantTimers.delays.filter((ms) => ms === 250)).toHaveLength(2);
  });

  test("reports a failed transaction found by the signature status", async () => {
    const wallet = walletWith({
      getTransaction: async () => null,
      getSignatureStatus: async () => ({
        value: { err: "ProgramFailed", confirmationStatus: "confirmed" },
      }),
    });

    expect(await probe(wallet)).toBe("failed");
    expect(messages(errorSpy).some((m) => m.includes("signature status reports failure"))).toBe(
      true,
    );
  });

  test.each(["confirmed", "finalized"])("accepts a %s signature status", async (status) => {
    const wallet = walletWith({
      getTransaction: async () => null,
      getSignatureStatus: async () => ({ value: { err: null, confirmationStatus: status } }),
    });

    expect(await probe(wallet)).toBe("found");
    expect(messages(logSpy).some((m) => m.includes(`with status ${status}`))).toBe(true);
  });

  test("treats a processed-only status as still missing", async () => {
    const wallet = walletWith({
      getTransaction: async () => null,
      getSignatureStatus: async () => ({ value: { err: null, confirmationStatus: "processed" } }),
    });

    expect(await probe(wallet)).toBe("missing");
    expect(messages(logSpy).some((m) => m.includes("with status processed"))).toBe(true);
  });

  test("labels a status without a confirmation level as unknown and keeps it missing", async () => {
    const wallet = walletWith({
      getTransaction: async () => null,
      getSignatureStatus: async () => ({ value: { err: null } }),
    });

    expect(await probe(wallet)).toBe("missing");
    expect(messages(logSpy).some((m) => m.includes("with status unknown"))).toBe(true);
  });

  test("retries a rate limited signature status and then stops at the attempt limit", async () => {
    let statusCalls = 0;
    const wallet = walletWith({
      getTransaction: async () => null,
      getSignatureStatus: async () => {
        statusCalls += 1;
        throw new Error("Too Many Requests");
      },
    });

    expect(await probe(wallet)).toBe("missing");
    expect(statusCalls).toBe(3);
    const warnings = messages(warnSpy);
    expect(
      warnings.filter((m) => m.includes("(attempt 1)") || m.includes("(attempt 2)")),
    ).toHaveLength(2);
    expect(
      warnings.some((m) =>
        m.includes("getSignatureStatus probe for SIGPROBE failed: Too Many Requests"),
      ),
    ).toBe(true);
    expect(instantTimers.delays.filter((ms) => ms === 250)).toHaveLength(2);
  });

  test("a non-retryable status error ends the status check immediately", async () => {
    let statusCalls = 0;
    const wallet = walletWith({
      getTransaction: async () => null,
      getSignatureStatus: async () => {
        statusCalls += 1;
        throw "boom";
      },
    });

    expect(await probe(wallet)).toBe("missing");
    expect(statusCalls).toBe(1);
  });
});
