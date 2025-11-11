import { describe, expect, test } from "bun:test";
import { createRebateAwareFetch } from "../src/utils/helius-rebate-fetch";

type CallRecord = {
  input: string;
  init?: RequestInit | BunFetchRequestInit;
};

function createSpyFetch(): {
  fetch: typeof fetch;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit | BunFetchRequestInit,
  ) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
});
