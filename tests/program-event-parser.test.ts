import { describe, expect, it } from "bun:test";
import { PublicKey } from "#solana";
import {
  PLAYER_UNJOINED_DISCRIMINATOR,
  decodeLegacyPlayerUnjoined,
  decodeProgramEventLog,
  parseProgramEventLogs,
} from "../src/utils/program-event-parser";

const GAME = new PublicKey("11111111111111111111111111111112");
const PLAYER = new PublicKey("So11111111111111111111111111111111111111112");

/** Encode a pre-moved_participant PlayerUnjoined program-data payload. */
function encodeLegacyPlayerUnjoined(fields: {
  gameKey: PublicKey;
  player: PublicKey;
  totalAmount: bigint;
  ticketsCount: number;
  ticketIndex: number;
  lastSlot: bigint;
  timestamp: bigint;
}): string {
  const body = Buffer.alloc(96);
  let o = 0;
  body.set(fields.gameKey.toBytes(), o);
  o += 32;
  body.set(fields.player.toBytes(), o);
  o += 32;
  body.writeBigUInt64LE(fields.totalAmount, o);
  o += 8;
  body.writeUInt32LE(fields.ticketsCount, o);
  o += 4;
  body.writeUInt32LE(fields.ticketIndex, o);
  o += 4;
  body.writeBigUInt64LE(fields.lastSlot, o);
  o += 8;
  body.writeBigUInt64LE(fields.timestamp, o);
  return Buffer.concat([PLAYER_UNJOINED_DISCRIMINATOR, body]).toString("base64");
}

function encodeGameCompleted(feeAmount: bigint): string {
  const payload = Buffer.alloc(8 + 32 + 32 + 4 + 8 + 8 + 8);
  Buffer.from([103, 26, 106, 108, 240, 191, 179, 120]).copy(payload, 0);
  GAME.toBuffer().copy(payload, 8);
  PLAYER.toBuffer().copy(payload, 40);
  payload.writeUInt32LE(1, 72);
  payload.writeBigUInt64LE(10n, 76);
  payload.writeBigUInt64LE(feeAmount, 84);
  payload.writeBigUInt64LE(100n, 92);
  return payload.toString("base64");
}

describe("legacy PlayerUnjoined layout", () => {
  it("decodes pre-moved_participant events with movedParticipant null", () => {
    // lastSlot LE first byte = 7 would be an invalid Option tag under the new layout.
    const log = encodeLegacyPlayerUnjoined({
      gameKey: GAME,
      player: PLAYER,
      totalAmount: 1_000_000n,
      ticketsCount: 3,
      ticketIndex: 1,
      lastSlot: 7n,
      timestamp: 1_700_000_000n,
    });

    const event = decodeLegacyPlayerUnjoined(log);
    expect(event).not.toBeNull();
    expect(event!.name).toBe("PlayerUnjoined");
    expect((event!.data["gameKey"] as PublicKey).equals(GAME)).toBe(true);
    expect((event!.data["player"] as PublicKey).equals(PLAYER)).toBe(true);
    expect(event!.data["totalAmount"]).toBe(1_000_000n);
    expect(event!.data["ticketsCount"]).toBe(3);
    expect(event!.data["ticketIndex"]).toBe(1);
    expect(event!.data["movedParticipant"]).toBeNull();
    expect(event!.data["lastSlot"]).toBe(7n);
    expect(event!.data["timestamp"]).toBe(1_700_000_000n);
  });

  it("rejects current-layout (longer) payloads so the IDL handles them", () => {
    const legacy = Buffer.from(
      encodeLegacyPlayerUnjoined({
        gameKey: GAME,
        player: PLAYER,
        totalAmount: 1n,
        ticketsCount: 0,
        ticketIndex: 0,
        lastSlot: 1n,
        timestamp: 2n,
      }),
      "base64",
    );
    // Option::None + rest already in buffer would be wrong size; append one byte.
    const longer = Buffer.concat([legacy, Buffer.from([0])]).toString("base64");
    expect(decodeLegacyPlayerUnjoined(longer)).toBeNull();
  });
});

describe("decodeProgramEventLog", () => {
  it("uses legacy layout before current IDL so last_slot is not misread as Option", () => {
    const log = encodeLegacyPlayerUnjoined({
      gameKey: GAME,
      player: PLAYER,
      totalAmount: 5n,
      ticketsCount: 1,
      ticketIndex: 0,
      // First byte 1 would look like Option::Some to the new layout.
      lastSlot: 1n,
      timestamp: 99n,
    });

    const currentCalled: string[] = [];
    const event = decodeProgramEventLog(log, (entry) => {
      currentCalled.push(entry);
      throw new Error("should not reach current IDL for exact legacy size");
    });

    expect(currentCalled).toEqual([]);
    expect(event?.data["movedParticipant"]).toBeNull();
    expect(event?.data["lastSlot"]).toBe(1n);
  });

  it("falls back to null when current IDL throws and payload is not legacy unjoin", () => {
    const event = decodeProgramEventLog("AAAA", () => {
      throw new Error("Invalid option movedParticipant");
    });
    expect(event).toBeNull();
  });

  it("returns current IDL events when decode succeeds", () => {
    const event = decodeProgramEventLog("payload", () => ({
      name: "GameCompleted",
      data: { feeAmount: 10n },
    }));
    expect(event).toEqual({ name: "GameCompleted", data: { feeAmount: 10n } });
  });
});

describe("parseProgramEventLogs", () => {
  it("decodes historical v0.2 fee events with the fallback coder", () => {
    const programId = new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
    const operator = new PublicKey("11111111111111111111111111111112");
    const mint = new PublicKey("So11111111111111111111111111111111111111112");
    const payload = Buffer.alloc(8 + 32 + 32 + 8);
    Buffer.from([92, 98, 195, 90, 108, 129, 244, 119]).copy(payload, 0);
    operator.toBuffer().copy(payload, 8);
    mint.toBuffer().copy(payload, 40);
    payload.writeBigUInt64LE(123n, 72);

    const events = parseProgramEventLogs(programId, [
      `Program ${programId.toBase58()} invoke [1]`,
      `Program data: ${payload.toString("base64")}`,
      `Program ${programId.toBase58()} success`,
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("TokenFeeWithdrawn");
    expect((events[0]?.data["tokenMint"] as PublicKey).equals(mint)).toBe(true);
    expect(events[0]?.data["amount"]?.toString()).toBe("123");
  });

  it("recovers a legacy unjoin without aborting the log stream", () => {
    const programId = new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
    const legacyLog = encodeLegacyPlayerUnjoined({
      gameKey: GAME,
      player: PLAYER,
      totalAmount: 42n,
      ticketsCount: 2,
      ticketIndex: 1,
      lastSlot: 0x05n,
      timestamp: 123n,
    });

    const events = parseProgramEventLogs(programId, [
      `Program ${programId.toBase58()} invoke [1]`,
      `Program data: ${legacyLog}`,
      `Program ${programId.toBase58()} success`,
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("PlayerUnjoined");
    expect(events[0]!.data["movedParticipant"]).toBeNull();
    expect(events[0]!.data["totalAmount"]).toBe(42n);
  });

  it("still surfaces fee events when a prior log would have thrown under the current IDL", () => {
    const programId = new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
    const legacyLog = encodeLegacyPlayerUnjoined({
      gameKey: GAME,
      player: PLAYER,
      totalAmount: 1n,
      ticketsCount: 0,
      ticketIndex: 0,
      lastSlot: 9n,
      timestamp: 1n,
    });
    const feeLog = encodeGameCompleted(7n);

    const events = parseProgramEventLogs(programId, [
      `Program ${programId.toBase58()} invoke [1]`,
      `Program data: ${legacyLog}`,
      `Program data: ${feeLog}`,
      `Program ${programId.toBase58()} success`,
    ]);

    expect(events.map((e) => e.name)).toEqual(["PlayerUnjoined", "GameCompleted"]);
    expect(events[1]!.data["feeAmount"]).toBe(7n);
  });
});
