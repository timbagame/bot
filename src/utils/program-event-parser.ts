import { PublicKey } from "#solana";
import type { TimbaProgram } from "./timba-program";

export const PLAYER_UNJOINED_DISCRIMINATOR = Buffer.from([191, 34, 140, 22, 253, 20, 237, 73]);

const DISCRIMINATORS = {
  GameCompleted: Buffer.from([103, 26, 106, 108, 240, 191, 179, 120]),
  GameInitialized: Buffer.from([82, 221, 11, 2, 244, 52, 240, 250]),
  PlayerJoined: Buffer.from([39, 144, 49, 106, 108, 210, 183, 38]),
  PlayerUnjoined: PLAYER_UNJOINED_DISCRIMINATOR,
  TokenFeeWithdrawn: Buffer.from([92, 98, 195, 90, 108, 129, 244, 119]),
} as const;

const LEGACY_PLAYER_UNJOINED_BODY_LEN = 32 + 32 + 8 + 4 + 4 + 8 + 8;

export type ProgramEvent = {
  name: string;
  data: Record<string, unknown>;
};

class EventReader {
  offset = 8;

  constructor(readonly bytes: Buffer) {}

  publicKey(): PublicKey {
    const value = new PublicKey(this.bytes.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return value;
  }

  u8(): number {
    return this.bytes.readUInt8(this.offset++);
  }

  u32(): number {
    const value = this.bytes.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.bytes.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }
}

function hasDiscriminator(bytes: Buffer, discriminator: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(discriminator);
}

export function decodeLegacyPlayerUnjoined(logBase64: string): ProgramEvent | null {
  const bytes = Buffer.from(logBase64, "base64");
  if (bytes.length !== 8 + LEGACY_PLAYER_UNJOINED_BODY_LEN) return null;
  if (!hasDiscriminator(bytes, PLAYER_UNJOINED_DISCRIMINATOR)) return null;
  const reader = new EventReader(bytes);
  return {
    name: "PlayerUnjoined",
    data: {
      gameKey: reader.publicKey(),
      player: reader.publicKey(),
      totalAmount: reader.u64(),
      ticketsCount: reader.u32(),
      ticketIndex: reader.u32(),
      movedParticipant: null,
      lastSlot: reader.u64(),
      timestamp: reader.u64(),
    },
  };
}

function decodeKnownEvent(logBase64: string): ProgramEvent | null {
  const bytes = Buffer.from(logBase64, "base64");
  const reader = new EventReader(bytes);

  if (hasDiscriminator(bytes, DISCRIMINATORS.GameCompleted)) {
    return {
      name: "GameCompleted",
      data: {
        gameKey: reader.publicKey(),
        winner: reader.publicKey(),
        ticketsCount: reader.u32(),
        winnerAmount: reader.u64(),
        feeAmount: reader.u64(),
        timestamp: reader.u64(),
      },
    };
  }
  if (hasDiscriminator(bytes, DISCRIMINATORS.GameInitialized)) {
    const gameKey = reader.publicKey();
    const creator = reader.publicKey();
    const gameType = reader.u8() === 0 ? { coinflip: {} } : { giveaway: {} };
    return {
      name: "GameInitialized",
      data: {
        gameKey,
        creator,
        gameType,
        ticketAmount: reader.u64(),
        totalAmount: reader.u64(),
        maxTickets: reader.u32(),
        minTickets: reader.u32(),
        tokenMint: reader.publicKey(),
        isPrivate: reader.u8() !== 0,
        createdAt: reader.u64(),
        timeout: reader.u64(),
      },
    };
  }
  if (hasDiscriminator(bytes, DISCRIMINATORS.PlayerJoined)) {
    return {
      name: "PlayerJoined",
      data: {
        gameKey: reader.publicKey(),
        player: reader.publicKey(),
        totalAmount: reader.u64(),
        ticketsCount: reader.u32(),
        ticketIndex: reader.u32(),
        lastSlot: reader.u64(),
        timestamp: reader.u64(),
      },
    };
  }
  if (hasDiscriminator(bytes, DISCRIMINATORS.PlayerUnjoined)) {
    const gameKey = reader.publicKey();
    const player = reader.publicKey();
    const totalAmount = reader.u64();
    const ticketsCount = reader.u32();
    const ticketIndex = reader.u32();
    const movedParticipant = reader.u8() === 0 ? null : reader.publicKey();
    return {
      name: "PlayerUnjoined",
      data: {
        gameKey,
        player,
        totalAmount,
        ticketsCount,
        ticketIndex,
        movedParticipant,
        lastSlot: reader.u64(),
        timestamp: reader.u64(),
      },
    };
  }
  if (hasDiscriminator(bytes, DISCRIMINATORS.TokenFeeWithdrawn)) {
    return {
      name: "TokenFeeWithdrawn",
      data: {
        operator: reader.publicKey(),
        tokenMint: reader.publicKey(),
        amount: reader.u64(),
      },
    };
  }
  return null;
}

export function decodeProgramEventLog(
  logBase64: string,
  decodeFallback?: (log: string) => ProgramEvent | null,
): ProgramEvent | null {
  try {
    return (
      decodeLegacyPlayerUnjoined(logBase64) ??
      decodeKnownEvent(logBase64) ??
      decodeFallback?.(logBase64) ??
      null
    );
  } catch {
    try {
      return decodeFallback?.(logBase64) ?? null;
    } catch {
      return null;
    }
  }
}

export function parseProgramEventLogs(
  programId: PublicKey,
  logs: readonly string[],
): ProgramEvent[] {
  const id = programId.toBase58();
  const stack: string[] = [];
  const events: ProgramEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke /.exec(line);
    if (invoke?.[1]) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \S+ (?:success|failed:)/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.at(-1) !== id || !line.startsWith("Program data: ")) continue;
    const event = decodeProgramEventLog(line.slice("Program data: ".length));
    if (event) events.push(event);
  }
  return events;
}

export function parseProgramEventsFromTransaction(
  program: Pick<TimbaProgram, "programId">,
  logs: readonly string[] | null | undefined,
): ProgramEvent[] {
  return parseProgramEventLogs(program.programId, logs ?? []);
}
