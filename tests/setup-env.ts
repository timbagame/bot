/**
 * Global test environment bootstrap.
 *
 * Ensures critical environment variables are present so modules that read
 * process.env at import time (like src/bot.ts) do not throw when the test
 * suite runs inside CI without secrets.
 *
 * We also guard against accidental live network access by replacing the
 * default global fetch with a stub that throws. Individual tests can
 * override globalThis.fetch when they need to assert on HTTP behaviour.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
  TELEGRAM_TOKEN: "TEST_TOKEN",
  MNEMONIC: "test walk nut penalty hip pave soap entry language right filter choice",
  SOLANA_NETWORK: "http://localhost:8899",
};

process.env.NODE_ENV = "test";

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

if (!process.env["BOT_DB_DIR"]) {
  process.env["BOT_DB_DIR"] = mkdtempSync(join(tmpdir(), "bot-tests-"));
}

const originalFetch = globalThis.fetch?.bind(globalThis);

// Expose the original fetch so tests can opt-in when required.
Object.assign(globalThis, {
  __TEST_ORIGINAL_FETCH__: originalFetch,
}) as any;

const buildJsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

// Disable outbound requests by default. Tests must stub fetch explicitly.
const disabledFetch = Object.assign(
  async function disabledFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : null;
    let rpcMethod: string | null = null;

    if (body) {
      try {
        const parsed = JSON.parse(body);
        rpcMethod = parsed?.method ?? null;
      } catch {
        // ignore body parse failures
      }
    }

    if (/jup.ag/.test(url)) {
      return buildJsonResponse({ data: {} });
    }

    if (/localhost:8899|solana/i.test(url) || rpcMethod) {
      if (rpcMethod === "getAccountInfo") {
        return buildJsonResponse({ result: { value: null } });
      }
      if (rpcMethod === "getBalance") {
        return buildJsonResponse({ result: 0 });
      }
      return buildJsonResponse({ result: null });
    }

    throw new Error("Network access is disabled in tests. Provide a mock for globalThis.fetch.");
  },
  {
    preconnect: async (..._args: Parameters<typeof fetch.preconnect>) => {
      throw new Error("Network access is disabled in tests. Provide a mock for fetch.preconnect.");
    },
  },
) as typeof fetch;

(globalThis as any).fetch = disabledFetch;
