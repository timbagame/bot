import { describe, expect, test } from "bun:test";
import { createRebateAwareFetch } from "../src/utils/helius-rebate-fetch";

type CallRecord = {
  input: string;
  init?: RequestInit | BunFetchRequestInit;
};

function createSpyFetch(delayMs = 0): { fetch: typeof fetch; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit | BunFetchRequestInit,
  ) => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    calls.push({ input: url, init });
    return { ok: true } as Response;
  }) as typeof fetch;

  return { fetch: fakeFetch, calls };
}

describe("createRebateAwareFetch", () => {
  test("only appends rebate-address for Helius hosts", async () => {
    const { fetch: spyFetch, calls } = createSpyFetch();
    const rebateFetch = createRebateAwareFetch(spyFetch, "RebateAddr");

    await rebateFetch("https://api.devnet.solana.com", {
      body: JSON.stringify({ method: "sendTransaction" }),
    });
    await rebateFetch("https://mainnet.helius-rpc.com/?api-key=badge", {
      body: JSON.stringify({ method: "sendTransaction" }),
    });

    expect(calls).toHaveLength(2);
    const firstCall = calls[0]!;
    const secondCall = calls[1]!;
    expect(firstCall.input).not.toContain("rebate-address");
    expect(secondCall.input).toContain("rebate-address=RebateAddr");
  });

  test("does not append rebate when payload lacks method", async () => {
    const { fetch: spyFetch, calls } = createSpyFetch();
    const rebateFetch = createRebateAwareFetch(spyFetch, "RebateAddr");

    await rebateFetch("https://mainnet.helius-rpc.com/?api-key=badge", {
      body: JSON.stringify({ params: [] }),
    });

    expect(calls).toHaveLength(1);
    const singleCall = calls[0]!;
    expect(singleCall.input).not.toContain("rebate-address");
  });

  test("handles URL objects by appending rebate query", async () => {
    const { fetch: spyFetch, calls } = createSpyFetch();
    const rebateFetch = createRebateAwareFetch(spyFetch, "RebateAddr");
    const url = new URL("https://mainnet.helius-rpc.com/?api-key=badge");

    await rebateFetch(url, {
      body: JSON.stringify({ method: "sendTransaction" }),
    });

    expect(calls).toHaveLength(1);
    const singleCall = calls[0]!;
    expect(singleCall.input).toContain("rebate-address=RebateAddr");
  });
  test("concurrent sendTransaction calls keep rebate parameter per request", async () => {
    const { fetch: spyFetch, calls } = createSpyFetch(5);
    const rebateFetch = createRebateAwareFetch(spyFetch, "RebateAddr");
    const url = "https://mainnet.helius-rpc.com/?api-key=badge";
    await Promise.all(
      Array.from({ length: 3 }, () =>
        rebateFetch(url, {
          body: JSON.stringify({ method: "sendTransaction" }),
        }),
      ),
    );

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.input).toContain("rebate-address=RebateAddr");
    }
  });

  test("does not log rebate address", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const { fetch: spyFetch } = createSpyFetch();
      const rebateFetch = createRebateAwareFetch(spyFetch, "secretRebate");
      await rebateFetch("https://mainnet.helius-rpc.com/?api-key=badge", {
        body: JSON.stringify({ method: "sendTransaction" }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(logs).toHaveLength(0);
  });

  test("propagates base fetch rejections", async () => {
    const error = new Error("network fail");
    const failingFetch = Object.assign(
      (async () => {
        throw error;
      }) as unknown as typeof fetch,
      {
        preconnect: (_url: string | URL) => Promise.resolve(),
      },
    );

    const rebateFetch = createRebateAwareFetch(failingFetch, "RebateAddr");
    await expect(
      rebateFetch("https://mainnet.helius-rpc.com/?api-key=badge", {
        body: JSON.stringify({ method: "sendTransaction" }),
      }),
    ).rejects.toThrow(error);
  });
});
