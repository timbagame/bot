import { PublicKey } from "@solana/web3.js";
import { getSupportedTokens } from "./token-registry";

const JUPITER_VERIFIED_URL = "https://api.jup.ag/tokens/v2/tag?query=verified";
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 3_000;

let verifiedMints = new Set(getSupportedTokens().map((token) => token.mint));
let refreshAfter = 0;
let refreshPromise: Promise<void> | undefined;

function isMint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

async function refreshVerifiedMints(): Promise<void> {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (!apiKey) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(JUPITER_VERIFIED_URL, {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });
    if (!response.ok) return;

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return;

    const next = new Set(getSupportedTokens().map((token) => token.mint));
    for (const entry of payload) {
      const mint = (entry as { id?: unknown })?.id;
      if (isMint(mint)) next.add(mint);
    }
    verifiedMints = next;
    refreshAfter = Date.now() + REFRESH_INTERVAL_MS;
  } catch {
    // Keep the last successful snapshot.
  } finally {
    clearTimeout(timer);
  }
}

export function getVerifiedTokenMints(): ReadonlySet<string> {
  if (Date.now() >= refreshAfter && !refreshPromise) {
    refreshAfter = Date.now() + REFRESH_INTERVAL_MS;
    refreshPromise = refreshVerifiedMints().finally(() => {
      refreshPromise = undefined;
    });
  }
  return verifiedMints;
}

export function sortTokensByRecognition<T extends { mint: string; ticker: string }>(
  tokens: T[],
  recognizedMints: ReadonlySet<string> = getVerifiedTokenMints(),
): T[] {
  return [...tokens].sort((left, right) => {
    const recognitionDelta =
      Number(recognizedMints.has(right.mint)) - Number(recognizedMints.has(left.mint));
    return (
      recognitionDelta ||
      left.ticker.localeCompare(right.ticker) ||
      left.mint.localeCompare(right.mint)
    );
  });
}

export function __test_setVerifiedTokenMints(mints: string[]): void {
  verifiedMints = new Set(mints);
  refreshAfter = Number.POSITIVE_INFINITY;
}
