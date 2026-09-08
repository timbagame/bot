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
