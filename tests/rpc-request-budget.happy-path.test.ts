import { describe, expect, test } from "bun:test";
import {
  RpcRetryLaterError,
  backgroundRpc,
  noteRpcRateLimit,
} from "../src/utils/rpc-request-budget";

describe("backgroundRpc", () => {
  test("runs the request and returns its result when idle", async () => {
    let calls = 0;
    const result = await backgroundRpc(
      "https://test-idle.test/key",
      AbortSignal.timeout(2000),
      async () => {
        calls += 1;
        return "payload";
      },
    );
    expect(result).toBe("payload");
    expect(calls).toBe(1);
  });

  test("rejects immediately with a retry-later error while the host is cooling down", async () => {
    const endpoint = "https://test-cooldown.test/key";
    const future = noteRpcRateLimit(endpoint, "3600");
    expect(future).toBeGreaterThan(Date.now());

    let called = false;
    const failure = await backgroundRpc(endpoint, AbortSignal.timeout(2000), async () => {
      called = true;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcRetryLaterError);
    expect((failure as RpcRetryLaterError).retryAt).toBe(future);
    expect((failure as Error).message).toContain("cooling down");
    expect(called).toBe(false);
  });
});
