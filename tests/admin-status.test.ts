import { describe, expect, test } from "bun:test";
import {
  BOT_ADMIN_IDS_ENV,
  RPC_SLOW_LATENCY_MS,
  collectAdminStatus,
  createAdminStatusCommand,
  describeRpcEndpoint,
  formatAdminStatus,
  probeRpcEndpoint,
  resolveBotAdminIds,
  type AdminStatusDeps,
} from "../src/handlers/admin-status";
import { FINANCE_ADMIN_TELEGRAM_IDS } from "../src/handlers/finance";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const baseDeps = (overrides: Partial<AdminStatusDeps> = {}): AdminStatusDeps => ({
  adminIds: new Set(["1"]),
  getRpcEndpoints: () => ["https://rpc-a.example/?api-key=secret", "https://rpc-b.example/key"],
  getActiveRpcEndpoint: () => "https://rpc-a.example/?api-key=secret",
  probeEndpoint: async (endpoint) =>
    endpoint.includes("rpc-a")
      ? { endpoint, ok: true, latencyMs: 142, slot: 312_345_678 }
      : { endpoint, ok: false, latencyMs: 3_000, error: "timed out" },
  getCallbackQueue: () => ({ length: 3, isProcessing: true }),
  getActiveGameLocks: () => 2,
  getPendingCreations: () => [
    { state: "submitted" },
    { state: "unknown", recovery_paused_at: 1 },
    { state: "submitted" },
  ],
  uptimeSeconds: () => 2 * 86_400 + 3_600 + 125,
  memoryUsage: () => ({
    rss: 200 * 1024 * 1024,
    heapUsed: 90 * 1024 * 1024,
    heapTotal: 140 * 1024 * 1024,
  }),
  ...overrides,
});

describe("admin ids", () => {
  test("finance admins plus env admins", () => {
    const ids = resolveBotAdminIds({ [BOT_ADMIN_IDS_ENV]: " 11, 22 ,abc,," });
    for (const id of FINANCE_ADMIN_TELEGRAM_IDS) expect(ids.has(id)).toBe(true);
    expect(ids.has("11")).toBe(true);
    expect(ids.has("22")).toBe(true);
    expect(ids.has("abc")).toBe(false);
    expect(resolveBotAdminIds({}).size).toBe(FINANCE_ADMIN_TELEGRAM_IDS.size);
  });
});

describe("rpc probe", () => {
  test("reports slot and latency", async () => {
    let clock = 100;
    let body: any;
    const result = await probeRpcEndpoint("https://rpc.example", {
      fetchFn: (async (_url: string, init: any) => {
        body = JSON.parse(init.body);
        clock += 42;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: 999 });
      }) as any,
      now: () => clock,
    });
    expect(body.method).toBe("getSlot");
    expect(result).toEqual({ endpoint: "https://rpc.example", ok: true, latencyMs: 42, slot: 999 });
  });

  test("reports HTTP, RPC and network failures without leaking URLs", async () => {
    const http = await probeRpcEndpoint("https://rpc.example", {
      fetchFn: (async () => jsonResponse({}, 503)) as any,
    });
    expect(http).toMatchObject({ ok: false, error: "HTTP 503" });

    const rpc = await probeRpcEndpoint("https://rpc.example", {
      fetchFn: (async () => jsonResponse({ error: { message: "node is behind" } })) as any,
    });
    expect(rpc).toMatchObject({ ok: false, error: "node is behind" });

    const odd = await probeRpcEndpoint("https://rpc.example", {
      fetchFn: (async () => jsonResponse({})) as any,
    });
    expect(odd).toMatchObject({ ok: false, error: "unexpected response" });

    const timedOut = await probeRpcEndpoint("https://rpc.example", {
      fetchFn: (async () => {
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      }) as any,
    });
    expect(timedOut).toMatchObject({ ok: false, error: "timed out" });

    const network = await probeRpcEndpoint("https://rpc.example", {
      fetchFn: (async () => {
        throw new Error("Unable to connect to https://rpc.example/?api-key=secret");
      }) as any,
    });
    expect(network).toMatchObject({ ok: false, error: "Unable to connect to [url]" });
  });

  test("endpoint labels only show the host", () => {
    expect(describeRpcEndpoint("https://mainnet.helius-rpc.com/?api-key=secret")).toBe(
      "mainnet.helius-rpc.com",
    );
    expect(describeRpcEndpoint("not a url")).toBe("unknown endpoint");
  });
});

describe("status snapshot and rendering", () => {
  test("collects every section", async () => {
    const snapshot = await collectAdminStatus(baseDeps());
    expect(snapshot.rpc.map((probe) => probe.active)).toEqual([true, false]);
    expect(snapshot.callbackQueue).toEqual({ length: 3, processing: true });
    expect(snapshot.activeGameLocks).toBe(2);
    expect(snapshot.pendingCreations).toHaveLength(3);
  });

  test("renders a compact admin card without secrets", async () => {
    const text = formatAdminStatus(await collectAdminStatus(baseDeps()));
    expect(text).toBe(
      [
        "🩺 <b>Bot status</b>",
        "",
        "<b>RPC endpoints</b>",
        "✅ 1. rpc-a.example (active): 142 ms, slot 312,345,678",
        "❌ 2. rpc-b.example: timed out",
        "",
        "<b>Queues</b>",
        "Callback answer queue: 3 (draining)",
        "Active game locks: 2",
        "Pending game creations: 3 (2 submitted, 1 unknown, 1 paused)",
        "",
        "<b>Process</b>",
        "Uptime: 2d 1h 2m",
        "Memory: 200 MB RSS, heap 90 MB of 140 MB",
      ].join("\n"),
    );
    expect(text).not.toContain("secret");
    expect(text).not.toMatch(/[—·]/);
  });

  test("renders slow, empty and idle states", async () => {
    const text = formatAdminStatus(
      await collectAdminStatus(
        baseDeps({
          getRpcEndpoints: () => ["https://slow.example"],
          getActiveRpcEndpoint: () => undefined,
          probeEndpoint: async (endpoint) => ({
            endpoint,
            ok: true,
            latencyMs: RPC_SLOW_LATENCY_MS,
            slot: 1,
          }),
          getCallbackQueue: () => null,
          getPendingCreations: () => {
            throw new Error("db closed");
          },
          uptimeSeconds: () => 59,
        }),
      ),
    );
    expect(text).toContain("⚠️ 1. slow.example: 800 ms, slot 1");
    expect(text).toContain("Callback answer queue: not started");
    expect(text).toContain("Pending game creations: 0");
    expect(text).toContain("Uptime: 59s");

    const idle = formatAdminStatus(
      await collectAdminStatus(
        baseDeps({
          getRpcEndpoints: () => [],
          getCallbackQueue: () => ({ length: 0, isProcessing: false }),
        }),
      ),
    );
    expect(idle).toContain("No RPC endpoints configured");
    expect(idle).toContain("Callback answer queue: 0 (idle)");
  });

  test("defaults read the live process", async () => {
    const snapshot = await collectAdminStatus(
      baseDeps({ uptimeSeconds: undefined, memoryUsage: undefined, getRpcEndpoints: () => [] }),
    );
    expect(snapshot.uptimeSeconds).toBeGreaterThan(0);
    expect(snapshot.memory.rss).toBeGreaterThan(0);
  });
});

describe("/status command", () => {
  const makeCtx = (id: number, type = "private") => {
    const replies: Array<[string, any]> = [];
    return {
      replies,
      ctx: {
        chat: { id, type },
        from: { id },
        reply: async (text: string, options: any) => {
          replies.push([text, options]);
        },
      } as any,
    };
  };

  test("admins get the status card in a private chat", async () => {
    const command = createAdminStatusCommand(baseDeps());
    const { ctx, replies } = makeCtx(1);
    await command.handle(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]![0]).toContain("🩺 <b>Bot status</b>");
    expect(replies[0]![1].parse_mode).toBe("HTML");
  });

  test("everyone else, and group chats, get nothing", async () => {
    const command = createAdminStatusCommand(baseDeps());
    for (const { ctx, replies } of [makeCtx(2), makeCtx(1, "supergroup")]) {
      await command.handle(ctx);
      expect(replies).toHaveLength(0);
    }
    expect(command.isAuthorized({ chat: { type: "private" } } as any)).toBe(false);
  });

  test("defaults to the configured admin list", () => {
    const command = createAdminStatusCommand({ ...baseDeps(), adminIds: undefined });
    const [financeAdmin] = [...FINANCE_ADMIN_TELEGRAM_IDS];
    expect(
      command.isAuthorized({
        chat: { type: "private" },
        from: { id: Number(financeAdmin) },
      } as any),
    ).toBe(true);
  });
});
