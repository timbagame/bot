import type { Context } from "grammy";
import { FINANCE_ADMIN_TELEGRAM_IDS } from "./finance";
import { escapeHtml } from "../utils/format-amount";
import { formatDuration } from "../utils/format-time";

/** Extra admins, as comma separated Telegram user IDs, on top of the finance admins. */
export const BOT_ADMIN_IDS_ENV = "BOT_ADMIN_TELEGRAM_IDS";
/** Per endpoint budget for the getSlot probe. */
export const RPC_PROBE_TIMEOUT_MS = 3_000;
/** Probes slower than this are flagged as degraded. */
export const RPC_SLOW_LATENCY_MS = 800;

export const resolveBotAdminIds = (
  env: Record<string, string | undefined> = process.env,
): Set<string> => {
  const ids = new Set(FINANCE_ADMIN_TELEGRAM_IDS);
  for (const raw of (env[BOT_ADMIN_IDS_ENV] ?? "").split(",")) {
    const id = raw.trim();
    if (/^\d+$/.test(id)) ids.add(id);
  }
  return ids;
};

export type RpcProbeResult =
  | { endpoint: string; ok: true; latencyMs: number; slot: number }
  | { endpoint: string; ok: false; latencyMs: number; error: string };

export type AdminStatusSnapshot = {
  rpc: Array<RpcProbeResult & { active: boolean }>;
  callbackQueue: { length: number; processing: boolean } | null;
  activeGameLocks: number;
  pendingCreations: Array<{ state: string; paused: boolean }>;
  uptimeSeconds: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
};

/** Host only: RPC URLs often carry API keys in the path or query string. */
export const describeRpcEndpoint = (endpoint: string): string => {
  try {
    return new URL(endpoint).host || "unknown endpoint";
  } catch {
    return "unknown endpoint";
  }
};

const describeProbeError = (error: unknown): string => {
  const name = String((error as { name?: unknown })?.name ?? "");
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  const message = error instanceof Error ? error.message : String(error);
  // Keep it short and free of URLs, which may include credentials.
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 80) || "error";
};

/** Times one getSlot JSON-RPC call against `endpoint`. Never throws. */
export const probeRpcEndpoint = async (
  endpoint: string,
  options: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<RpcProbeResult> => {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as typeof fetch);
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
      signal: AbortSignal.timeout(options.timeoutMs ?? RPC_PROBE_TIMEOUT_MS),
    });
    const latencyMs = Math.round(now() - startedAt);
    if (!response.ok) {
      return { endpoint, ok: false, latencyMs, error: `HTTP ${response.status}` };
    }
    const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (typeof payload?.result !== "number") {
      return {
        endpoint,
        ok: false,
        latencyMs,
        error: describeProbeError(payload?.error?.message ?? "unexpected response"),
      };
    }
    return { endpoint, ok: true, latencyMs, slot: payload.result };
  } catch (error) {
    return {
      endpoint,
      ok: false,
      latencyMs: Math.round(now() - startedAt),
      error: describeProbeError(error),
    };
  }
};

const formatMegabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

const formatUptime = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const rest = formatDuration(total % 86_400);
  return days > 0 ? `${days}d ${rest}` : rest;
};

export const formatAdminStatus = (snapshot: AdminStatusSnapshot): string => {
  const rpcLines =
    snapshot.rpc.length === 0
      ? ["No RPC endpoints configured"]
      : snapshot.rpc.map((probe, index) => {
          const label = `${index + 1}. ${escapeHtml(describeRpcEndpoint(probe.endpoint))}${
            probe.active ? " (active)" : ""
          }`;
          if (!probe.ok) {
            return `❌ ${label}: ${escapeHtml(probe.error)}`;
          }
          const icon = probe.latencyMs >= RPC_SLOW_LATENCY_MS ? "⚠️" : "✅";
          return `${icon} ${label}: ${probe.latencyMs.toLocaleString("en-US")} ms, slot ${probe.slot.toLocaleString("en-US")}`;
        });

  const queue = snapshot.callbackQueue;
  const queueLine = queue
    ? `Callback answer queue: ${queue.length}${queue.processing ? " (draining)" : " (idle)"}`
    : "Callback answer queue: not started";

  const byState = new Map<string, number>();
  let paused = 0;
  for (const record of snapshot.pendingCreations) {
    byState.set(record.state, (byState.get(record.state) ?? 0) + 1);
    if (record.paused) paused += 1;
  }
  const breakdown = [...byState.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${count} ${escapeHtml(state)}`);
  if (paused > 0) breakdown.push(`${paused} paused`);
  const pendingLine = `Pending game creations: ${snapshot.pendingCreations.length}${
    breakdown.length > 0 ? ` (${breakdown.join(", ")})` : ""
  }`;

  const { rss, heapUsed, heapTotal } = snapshot.memory;

  return [
    "🩺 <b>Bot status</b>",
    "",
    "<b>RPC endpoints</b>",
    ...rpcLines,
    "",
    "<b>Queues</b>",
    queueLine,
    `Active game locks: ${snapshot.activeGameLocks}`,
    pendingLine,
    "",
    "<b>Process</b>",
    `Uptime: ${formatUptime(snapshot.uptimeSeconds)}`,
    `Memory: ${formatMegabytes(rss)} RSS, heap ${formatMegabytes(heapUsed)} of ${formatMegabytes(heapTotal)}`,
  ].join("\n");
};

export type AdminStatusDeps = {
  adminIds?: Set<string>;
  getRpcEndpoints: () => readonly string[];
  getActiveRpcEndpoint: () => string | undefined;
  probeEndpoint?: (endpoint: string) => Promise<RpcProbeResult>;
  getCallbackQueue: () => { length: number; isProcessing: boolean } | null;
  getActiveGameLocks: () => number;
  getPendingCreations: () => Array<{ state: string; recovery_paused_at?: number | null }>;
  uptimeSeconds?: () => number;
  memoryUsage?: () => { rss: number; heapUsed: number; heapTotal: number };
};

export const collectAdminStatus = async (deps: AdminStatusDeps): Promise<AdminStatusSnapshot> => {
  const probe = deps.probeEndpoint ?? ((endpoint: string) => probeRpcEndpoint(endpoint));
  const endpoints = [...new Set(deps.getRpcEndpoints())];
  const active = deps.getActiveRpcEndpoint();
  const probes = await Promise.all(endpoints.map((endpoint) => probe(endpoint)));

  let pendingCreations: AdminStatusSnapshot["pendingCreations"] = [];
  try {
    pendingCreations = deps
      .getPendingCreations()
      .map((record) => ({ state: record.state, paused: record.recovery_paused_at != null }));
  } catch (error) {
    console.warn("Unable to load pending game creations for /status:", error);
  }

  const queue = deps.getCallbackQueue();
  const memory = (deps.memoryUsage ?? (() => process.memoryUsage()))();

  return {
    rpc: probes.map((result) => ({ ...result, active: result.endpoint === active })),
    callbackQueue: queue ? { length: queue.length, processing: queue.isProcessing } : null,
    activeGameLocks: deps.getActiveGameLocks(),
    pendingCreations,
    uptimeSeconds: (deps.uptimeSeconds ?? (() => process.uptime()))(),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
  };
};

/**
 * `/status` for bot admins in a private chat. Everyone else gets no response,
 * so the command stays invisible outside the admin list.
 */
export const createAdminStatusCommand = (deps: AdminStatusDeps) => {
  const adminIds = deps.adminIds ?? resolveBotAdminIds();

  const isAuthorized = (ctx: Context): boolean =>
    ctx.chat?.type === "private" && ctx.from?.id !== undefined && adminIds.has(String(ctx.from.id));

  const handle = async (ctx: Context): Promise<void> => {
    if (!isAuthorized(ctx)) return;
    const snapshot = await collectAdminStatus(deps);
    await ctx.reply(formatAdminStatus(snapshot), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  };

  return { handle, isAuthorized };
};
