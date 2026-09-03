import { EventParser, type Coder, type Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

/**
 * PlayerUnjoined discriminator (unchanged when moved_participant was added).
 * From the versioned Anchor IDL — keep in sync if the event is renamed.
 */
export const PLAYER_UNJOINED_DISCRIMINATOR = Buffer.from([191, 34, 140, 22, 253, 20, 237, 73]);

/** Body size of PlayerUnjoined before moved_participant existed. */
const LEGACY_PLAYER_UNJOINED_BODY_LEN =
  32 + // game_key
  32 + // player
  8 + // total_amount
  4 + // tickets_count
  4 + // ticket_index
  8 + // last_slot
  8; // timestamp

export type ProgramEvent = {
  name: string;
  data: Record<string, unknown>;
};

/**
 * Decode a PlayerUnjoined event emitted before moved_participant was added.
 * Returns null if the log is not that event or is the wrong size.
 */
export function decodeLegacyPlayerUnjoined(logBase64: string): ProgramEvent | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(logBase64, "base64");
  } catch {
    return null;
  }

  // Exact legacy size only — current IDL handles the longer post-upgrade payload.
  if (bytes.length !== 8 + LEGACY_PLAYER_UNJOINED_BODY_LEN) return null;
  if (!bytes.subarray(0, 8).equals(PLAYER_UNJOINED_DISCRIMINATOR)) return null;

  let o = 8;
  const gameKey = new PublicKey(bytes.subarray(o, o + 32));
  o += 32;
  const player = new PublicKey(bytes.subarray(o, o + 32));
  o += 32;
  const totalAmount = bytes.readBigUInt64LE(o);
  o += 8;
  const ticketsCount = bytes.readUInt32LE(o);
  o += 4;
  const ticketIndex = bytes.readUInt32LE(o);
  o += 4;
  const lastSlot = bytes.readBigUInt64LE(o);
  o += 8;
  const timestamp = bytes.readBigUInt64LE(o);

  return {
    name: "PlayerUnjoined",
    data: {
      gameKey,
      player,
      totalAmount,
      ticketsCount,
      ticketIndex,
      movedParticipant: null,
      lastSlot,
      timestamp,
    },
  };
}

/**
 * Decode one program-data log.
 * Exact-size pre-upgrade PlayerUnjoined is tried first (current IDL would
 * misread last_slot as moved_participant when its first byte is 0/1).
 * Then the current IDL; layout throws become null so other events still parse.
 */
export function decodeProgramEventLog(
  logBase64: string,
  decodeCurrent: (log: string) => ProgramEvent | null,
  decodeFallbacks: ReadonlyArray<(log: string) => ProgramEvent | null> = [],
): ProgramEvent | null {
  const legacy = decodeLegacyPlayerUnjoined(logBase64);
  if (legacy) return legacy;

  for (const decode of [decodeCurrent, ...decodeFallbacks]) {
    try {
      const event = decode(logBase64);
      if (event) return event;
    } catch {
      // Try the next versioned decoder.
    }
  }
  return null;
}

type EventCoderLike = Pick<Coder, "events">;

function normalizeEventData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

/**
 * Parse a transaction's program logs with dual-layout support so a single
 * historical event shape cannot abort the whole log stream.
 */
export function parseProgramEventLogs(
  programId: PublicKey,
  coder: EventCoderLike,
  logs: readonly string[],
  fallbackCoders: readonly EventCoderLike[] = [],
): ProgramEvent[] {
  const resilientCoder = {
    events: {
      decode: (log: string) =>
        decodeProgramEventLog(
          log,
          (entry) => {
            const decoded = coder.events.decode(entry);
            return decoded
              ? {
                  name: decoded.name,
                  data: normalizeEventData(decoded.data as Record<string, unknown>),
                }
              : null;
          },
          fallbackCoders.map((fallback) => (entry: string) => {
            const decoded = fallback.events.decode(entry);
            return decoded
              ? {
                  name: decoded.name,
                  data: normalizeEventData(decoded.data as Record<string, unknown>),
                }
              : null;
          }),
        ),
    },
  } satisfies EventCoderLike;

  try {
    const parser = new EventParser(programId, resilientCoder as Coder);
    return [...parser.parseLogs([...logs])].map((event) => ({
      name: event.name,
      data: event.data as Record<string, unknown>,
    }));
  } catch (error) {
    // Structural log failures (unexpected first line, etc.) — rare and not recoverable.
    console.warn(`Unable to walk program event logs: ${error}`);
    return [];
  }
}

/** Convenience for Program callers. */
export function parseProgramEventsFromTransaction(
  program: Pick<Program, "programId" | "coder">,
  logs: readonly string[] | null | undefined,
  fallbackCoders: readonly EventCoderLike[] = [],
): ProgramEvent[] {
  return parseProgramEventLogs(program.programId, program.coder, logs ?? [], fallbackCoders);
}
