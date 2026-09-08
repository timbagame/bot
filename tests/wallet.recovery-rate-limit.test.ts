import { expect, test } from "bun:test";
import { WalletManager } from "../src/utils/wallet";
import { RpcRetryLaterError } from "../src/utils/rpc-request-budget";

for (const jsonError of [false, true]) {
  test(`recovery recognizes rate limits before treating them as unusable history: json=${jsonError}`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonError
        ? Response.json({ error: { code: 429, message: "Too Many Requests" } })
        : new Response("Too Many Requests", {
            status: 429,
            headers: { "retry-after": "9" },
          })) as unknown as typeof fetch;
    try {
      const wallet = Object.create(WalletManager.prototype) as any;
      const before = Date.now();
      let caught: unknown;
      try {
        await wallet.recoveryRpc(`https://limited-${jsonError}.test`)("getBlock", [1]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RpcRetryLaterError);
      expect((caught as RpcRetryLaterError).retryAt).toBeGreaterThanOrEqual(
        before + (jsonError ? 5000 : 9000),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("raw fallback broadcasts add rebate to each Helius endpoint, but not reads", async () => {
  const originalFetch = globalThis.fetch;
  const originalRebate = process.env.HELIUS_REBATE_ADDRESS;
  const urls: URL[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(new URL(String(input)));
    return Response.json({ result: "signature" });
  }) as unknown as typeof fetch;
  process.env.HELIUS_REBATE_ADDRESS = "recipient";
  try {
    const wallet = Object.create(WalletManager.prototype) as any;
    for (const key of ["first", "second"])
      await wallet.recoveryRpc(`https://mainnet.helius-rpc.com/?api-key=${key}`)(
        "sendTransaction",
        [],
      );
    await wallet.recoveryRpc("https://mainnet.helius-rpc.com/?api-key=second")("getSlot", []);
    expect(urls.slice(0, 2).map((u) => u.searchParams.get("rebate-address"))).toEqual([
      "recipient",
      "recipient",
    ]);
    expect(urls[2]!.searchParams.has("rebate-address")).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRebate === undefined) delete process.env.HELIUS_REBATE_ADDRESS;
    else process.env.HELIUS_REBATE_ADDRESS = originalRebate;
  }
});
