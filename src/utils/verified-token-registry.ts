import { SolanaAddressSchema } from "@timbagame/protocol";
import { z } from "zod";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSupportedTokens } from "./token-registry";

const JUPITER_VERIFIED_URL = "https://api.jup.ag/tokens/v2/tag?query=verified";
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 3_000;
const verifiedTokenSnapshotSchema = z.object({
  savedAt: z.number().finite().nonnegative().default(0),
  mints: z.array(SolanaAddressSchema).default([]),
});
const jupiterVerifiedTokensSchema = z.array(z.object({ id: SolanaAddressSchema }).passthrough());

const localMints = () => getSupportedTokens().map((token) => token.mint);
const snapshotPath = join(
  resolve(process.env["BOT_DB_DIR"]?.trim() || process.cwd()),
  "verified-tokens.json",
);

function loadSnapshot(): { mints: Set<string>; savedAt: number } {
  const mints = new Set(localMints());
  try {
    const snapshot = verifiedTokenSnapshotSchema.parse(
      JSON.parse(readFileSync(snapshotPath, "utf8")),
    );
    for (const mint of snapshot.mints) mints.add(mint);
    return { mints, savedAt: snapshot.savedAt };
  } catch {
    return { mints, savedAt: 0 };
  }
}

function saveSnapshot(mints: ReadonlySet<string>): void {
  try {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const temporaryPath = `${snapshotPath}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify({ savedAt: Date.now(), mints: [...mints].sort() }),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, snapshotPath);
  } catch {
    // Persistence is best-effort; the in-memory snapshot remains usable.
  }
}

const initialSnapshot = loadSnapshot();
let verifiedMints = initialSnapshot.mints;
let refreshAfter = 0;
let refreshPromise: Promise<void> | undefined;

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

    const payload = jupiterVerifiedTokensSchema.safeParse(await response.json());
    if (!payload.success) return;

    const next = new Set(localMints());
    for (const entry of payload.data) next.add(entry.id);
    verifiedMints = next;
    saveSnapshot(next);
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
