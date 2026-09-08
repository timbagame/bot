/** Reserve provider capacity for user requests; recovery scans share one paced lane per host. */
let foregroundRequests = 0;
const lanes = new Map<string, { tail: Promise<unknown>; next: number; cooldown: number }>();
const laneFor = (endpoint: string) => {
  const host = new URL(endpoint).hostname;
  let lane = lanes.get(host);
  if (!lane) {
    lane = { tail: Promise.resolve(), next: 0, cooldown: 0 };
    lanes.set(host, lane);
  }
  return lane;
};

export class RpcRetryLaterError extends Error {
  constructor(
    message: string,
    public readonly retryAt: number,
  ) {
    super(message);
    this.name = "RpcRetryLaterError";
  }
}

export function noteRpcRateLimit(
  endpoint: string,
  retryAfter: string | null,
  now = Date.now(),
): number {
  const seconds = retryAfter == null ? NaN : Number(retryAfter);
  const date = retryAfter == null ? NaN : Date.parse(retryAfter);
  const retryAt = Number.isFinite(seconds)
    ? now + Math.max(1, seconds) * 1000
    : Number.isFinite(date)
      ? Math.max(now + 1000, date)
      : now + 5000;
  const lane = laneFor(endpoint);
  lane.cooldown = Math.max(lane.cooldown, retryAt);
  return lane.cooldown;
}

export async function foregroundRpc<T>(request: () => Promise<T>): Promise<T> {
  foregroundRequests++;
  try {
    return await request();
  } finally {
    foregroundRequests--;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function backgroundRpc<T>(
  endpoint: string,
  signal: AbortSignal,
  request: () => Promise<T>,
): Promise<T> {
  const lane = laneFor(endpoint);
  const run = lane.tail
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted();
      if (lane.cooldown > Date.now())
        throw new RpcRetryLaterError("Recovery RPC is cooling down", lane.cooldown);
      while (foregroundRequests > 0 || lane.next > Date.now()) {
        await delay(Math.max(10, Math.min(50, lane.next - Date.now())), signal);
      }
      signal.throwIfAborted();
      if (lane.cooldown > Date.now())
        throw new RpcRetryLaterError("Recovery RPC is cooling down", lane.cooldown);
      // Separate API keys on the same hostname do not multiply the scan budget.
      lane.next = Date.now() + 500;
      return request();
    });
  lane.tail = run;
  return run;
}

export async function boundedRpc<T>(request: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("RPC request timed out")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
