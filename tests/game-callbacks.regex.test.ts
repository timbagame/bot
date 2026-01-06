import { expect, test } from "bun:test";
import {
  decodeGameConfirmPayload,
  decodeMinPlayersChangePayload,
  decodeAmountSelectionPayload,
  decodeCustomPlayersPayload,
  decodePlayersSelectionPayload,
  decodeTimeoutChangePayload,
  decodeVisibilityPayload,
  encodeGameConfirmPayload,
  encodeAmountSelectionPayload,
  encodeCustomPlayersPayload,
  encodeMinPlayersChangePayload,
  encodePlayersSelectionPayload,
  encodeTimeoutChangePayload,
  encodeVisibilityPayload,
} from "../src/utils/callback-data";

const TELEGRAM_CALLBACK_LIMIT = 64;

test("confirm callback decoding stays compact and captures values", () => {
  const encoded =
    encodeGameConfirmPayload({
      gameType: "giveaway",
      amount: "0.75",
      players: 10,
      timeoutSeconds: 3600,
      minPlayers: 1,
      isPrivate: true,
      creatorId: "999",
    }) ?? "";
  expect(encoded.startsWith("cg|")).toBe(true);
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT);
  const decoded = decodeGameConfirmPayload(encoded)!;
  expect(decoded.gameType).toBe("giveaway");
  expect(decoded.amount).toBe("0.75");
  expect(decoded.players).toBe(10);
  expect(decoded.timeoutSeconds).toBe(3600);
  expect(decoded.minPlayers).toBe(1);
  expect(decoded.isPrivate).toBe(true);
  expect(decoded.creatorId).toBe("999");
});

test("visibility callback encodes toggle and decodes to target visibility", () => {
  const encoded =
    encodeVisibilityPayload({
      gameType: "coinflip",
      amount: "1.5",
      players: 4,
      isPrivate: false,
      creatorId: "777",
    }) ?? "";
  expect(encoded.startsWith("cv|")).toBe(true);
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT);
  const decoded = decodeVisibilityPayload(encoded)!;
  expect(decoded.gameType).toBe("coinflip");
  expect(decoded.amount).toBe("1.5");
  expect(decoded.players).toBe(4);
  expect(decoded.isPrivate).toBe(false);
  expect(decoded.creatorId).toBe("777");
});

test("timeout callback captures delta minutes", () => {
  const encoded =
    encodeTimeoutChangePayload({
      gameType: "giveaway",
      amount: "0.25",
      players: 8,
      deltaMinutes: -15,
      creatorId: "999",
    }) ?? "";
  expect(encoded.startsWith("ct|")).toBe(true);
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT);
  const decoded = decodeTimeoutChangePayload(encoded)!;
  expect(decoded.gameType).toBe("giveaway");
  expect(decoded.amount).toBe("0.25");
  expect(decoded.players).toBe(8);
  expect(decoded.deltaMinutes).toBe(-15);
  expect(decoded.creatorId).toBe("999");
});

test("min player callback captures deltas", () => {
  const encoded =
    encodeMinPlayersChangePayload({
      gameType: "coinflip",
      amount: "2",
      players: 6,
      deltaPlayers: 1,
      creatorId: "111",
    }) ?? "";
  expect(encoded.startsWith("cm|")).toBe(true);
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT);
  const decoded = decodeMinPlayersChangePayload(encoded)!;
  expect(decoded.gameType).toBe("coinflip");
  expect(decoded.amount).toBe("2");
  expect(decoded.players).toBe(6);
  expect(decoded.deltaPlayers).toBe(1);
  expect(decoded.creatorId).toBe("111");
});

test("amount selection callback stays compact", () => {
  const encoded =
    encodeAmountSelectionPayload({
      gameType: "coinflip",
      amount: "12345.67",
      creatorId: "12345",
    }) ?? "";
  expect(encoded.startsWith("ga|")).toBe(true);
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT);
  const decoded = decodeAmountSelectionPayload(encoded)!;
  expect(decoded.gameType).toBe("coinflip");
  expect(decoded.amount).toBe("12345.67");
  expect(decoded.creatorId).toBe("12345");
});

test("player selection callback stays compact", () => {
  const encoded =
    encodePlayersSelectionPayload({
      gameType: "giveaway",
      amount: "99999.123456",
      players: 25,
      creatorId: "abc123",
    }) ?? "";
  expect(encoded.startsWith("gp|")).toBe(true);
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT);
  const decoded = decodePlayersSelectionPayload(encoded)!;
  expect(decoded.gameType).toBe("giveaway");
  expect(decoded.amount).toBe("99999.123456");
  expect(decoded.players).toBe(25);
  expect(decoded.creatorId).toBe("abc123");
});

test("custom players callback stays compact", () => {
  const encoded =
    encodeCustomPlayersPayload({
      gameType: "coinflip",
      amount: "1234567890.5",
      creatorId: "creator999",
    }) ?? "";
  expect(encoded.startsWith("gcp|")).toBe(true);
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_LIMIT);
  const decoded = decodeCustomPlayersPayload(encoded)!;
  expect(decoded.gameType).toBe("coinflip");
  expect(decoded.amount).toBe("1234567890.5");
  expect(decoded.creatorId).toBe("creator999");
});
