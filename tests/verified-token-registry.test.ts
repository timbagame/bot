import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  __test_reloadVerifiedTokenSnapshot,
  __test_setVerifiedTokenMints,
  __test_snapshotPath,
  __test_waitForVerifiedTokenRefresh,
  getVerifiedTokenMints,
  sortTokensByRecognition,
} from "../src/utils/verified-token-registry";
import { getSupportedTokens } from "../src/utils/token-registry";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const localMints = () => getSupportedTokens().map((token) => token.mint);

const originalFetch = globalThis.fetch;
const originalKey = process.env["JUPITER_API_KEY"];
let requests: { url: string; init?: RequestInit }[];

const respondWith = (response: () => Response | Promise<Response>) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return response();
  }) as unknown as typeof fetch;
};

const refresh = async () => {
  getVerifiedTokenMints();
  await __test_waitForVerifiedTokenRefresh();
  return getVerifiedTokenMints();
};

beforeEach(() => {
  requests = [];
  rmSync(__test_snapshotPath, { force: true });
  rmSync(`${__test_snapshotPath}.tmp`, { recursive: true, force: true });
  process.env["JUPITER_API_KEY"] = "test-key";
  __test_reloadVerifiedTokenSnapshot();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env["JUPITER_API_KEY"];
  else process.env["JUPITER_API_KEY"] = originalKey;
  rmSync(__test_snapshotPath, { force: true });
  rmSync(`${__test_snapshotPath}.tmp`, { recursive: true, force: true });
  __test_setVerifiedTokenMints(localMints());
});

describe("verified token registry refresh", () => {
  test("adds Jupiter-verified mints, keeps local ones and persists a sorted snapshot", async () => {
    respondWith(() => Response.json([{ id: USDC, name: "USD Coin" }, { id: BONK }]));

    const mints = await refresh();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.jup.ag/tokens/v2/tag?query=verified");
    expect((requests[0]!.init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(mints.has(USDC)).toBe(true);
    expect(mints.has(BONK)).toBe(true);
    for (const mint of localMints()) expect(mints.has(mint)).toBe(true);

    const snapshot = JSON.parse(readFileSync(__test_snapshotPath, "utf8"));
    expect(snapshot.mints).toEqual([...snapshot.mints].sort());
    expect(snapshot.mints).toContain(BONK);
    expect(statSync(__test_snapshotPath).mode & 0o777).toBe(0o600);
  });

  test("does not refetch within the refresh interval", async () => {
    respondWith(() => Response.json([{ id: USDC }]));

    await refresh();
    await refresh();

    expect(requests).toHaveLength(1);
  });

  test("a persisted snapshot is loaded on the next start", async () => {
    respondWith(() => Response.json([{ id: BONK }]));
    await refresh();
    __test_setVerifiedTokenMints([]);

    const reloaded = __test_reloadVerifiedTokenSnapshot();

    expect(reloaded.has(BONK)).toBe(true);
  });

  test("a corrupt snapshot falls back to the local token list", () => {
    writeFileSync(__test_snapshotPath, "{not json");

    const reloaded = __test_reloadVerifiedTokenSnapshot();

    expect([...reloaded].sort()).toEqual([...new Set(localMints())].sort());
  });

  test("skips the request entirely without an API key", async () => {
    delete process.env["JUPITER_API_KEY"];
    respondWith(() => Response.json([{ id: BONK }]));

    const mints = await refresh();

    expect(requests).toHaveLength(0);
    expect(mints.has(BONK)).toBe(false);
  });

  test.each([
    ["an HTTP error", () => new Response("rate limited", { status: 429 })],
    ["an invalid payload", () => Response.json([{ id: "not-a-mint" }])],
    [
      "a network failure",
      () => {
        throw new Error("offline");
      },
    ],
  ])("keeps the previous snapshot after %s", async (_label, response) => {
    respondWith(response);

    const mints = await refresh();

    expect(requests).toHaveLength(1);
    expect(mints.has(BONK)).toBe(false);
    expect(existsSync(__test_snapshotPath)).toBe(false);
  });

  test("keeps the refreshed mints in memory when the snapshot cannot be written", async () => {
    mkdirSync(`${__test_snapshotPath}.tmp`, { recursive: true });
    respondWith(() => Response.json([{ id: BONK }]));

    const mints = await refresh();

    expect(mints.has(BONK)).toBe(true);
    expect(existsSync(__test_snapshotPath)).toBe(false);
  });
});

describe("sortTokensByRecognition", () => {
  test("puts recognised tokens first, then sorts by ticker and mint", () => {
    const tokens = [
      { mint: "c", ticker: "ZED" },
      { mint: "b", ticker: "ABC" },
      { mint: "a", ticker: "ABC" },
      { mint: "v", ticker: "YAY" },
    ];

    const sorted = sortTokensByRecognition(tokens, new Set(["v", "c"]));

    expect(sorted.map((token) => token.mint)).toEqual(["v", "c", "a", "b"]);
    expect(tokens[0]!.mint).toBe("c");
  });

  test("defaults to the current verified set", () => {
    __test_setVerifiedTokenMints(["x"]);

    const sorted = sortTokensByRecognition([
      { mint: "a", ticker: "A" },
      { mint: "x", ticker: "X" },
    ]);

    expect(sorted[0]!.mint).toBe("x");
  });
});
