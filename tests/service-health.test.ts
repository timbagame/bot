import { expect, test } from "bun:test";
import { checkServiceHealth } from "../src/utils/service-health";

test("checkServiceHealth returns true on ok: true", async () => {
  const okFetch = async () => ({ ok: true } as any);
  const res = await checkServiceHealth("https://example.com/health", 100, okFetch as any);
  expect(res).toBe(true);
});

test("checkServiceHealth returns false on ok: false", async () => {
  const badFetch = async () => ({ ok: false } as any);
  const res = await checkServiceHealth("https://example.com/health", 100, badFetch as any);
  expect(res).toBe(false);
});

test("checkServiceHealth handles errors and returns false", async () => {
  const throwingFetch = async () => { throw new Error("network"); };
  const res = await checkServiceHealth("https://example.com/health", 100, throwingFetch as any);
  expect(res).toBe(false);
});

