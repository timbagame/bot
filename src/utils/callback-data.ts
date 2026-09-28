import type { GameType } from "../types";

export const CALLBACK_DATA_LIMIT = 64;

const CALLBACK_SEPARATOR = "|";
const AMOUNT_SEPARATOR = ":";
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const CALLBACK_PREFIX = {
  confirmGame: "cg",
  timeoutChange: "ct",
  visibility: "cv",
  minPlayersChange: "cm",
  amountSelection: "ga",
  playersSelection: "gp",
  customPlayers: "gcp",
} as const;

type CallbackPrefix = (typeof CALLBACK_PREFIX)[keyof typeof CALLBACK_PREFIX];

const toGameTypeCode = (gameType: GameType): "c" | "g" => {
  return gameType === "coinflip" ? "c" : "g";
};

const fromGameTypeCode = (code: string): GameType | null => {
  if (code === "c") return "coinflip";
  if (code === "g") return "giveaway";
  return null;
};

const decodeBase36ToBigInt = (value: string): bigint | null => {
  if (value.length === 0) return null;
  const isNegative = value.startsWith("-");
  const raw = isNegative ? value.slice(1) : value;
  let result = 0n;

  for (const char of raw.toLowerCase()) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) return null;
    result = result * 36n + BigInt(idx);
  }

  return isNegative ? -result : result;
};

const encodeUnsigned = (value: number): string | null => {
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value);
  if (rounded < 0) return null;
  return rounded.toString(36);
};

const encodeSigned = (value: number): string | null => {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded.toString(36);
};

const decodeUnsigned = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 36);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

const decodeSigned = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 36);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const normalizeAmount = (amount: string): { digits: bigint; scale: number } | null => {
  if (typeof amount !== "string") return null;
  const trimmed = amount.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const [intPartRaw = "0", fractionRaw = ""] = trimmed.split(".");
  const intPart = intPartRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  const scale = fraction.length;
  const digitsString = `${intPart}${fraction}`;
  const digits = digitsString.length > 0 ? BigInt(digitsString) : 0n;
  return { digits, scale };
};

const encodeAmount = (amount: string): string | null => {
  const normalized = normalizeAmount(amount);
  if (!normalized) return null;
  const scalePart = normalized.scale.toString(36);
  const digitsPart = normalized.digits.toString(36);
  return [scalePart, digitsPart].join(AMOUNT_SEPARATOR);
};

const decodeAmount = (encoded: string | undefined): string | null => {
  if (!encoded) return null;
  const [scaleStr, digitsStr] = encoded.split(AMOUNT_SEPARATOR);
  if (scaleStr === undefined || digitsStr === undefined) return null;
  const scale = Number.parseInt(scaleStr, 36);
  if (!Number.isFinite(scale) || scale < 0) return null;
  const digits = decodeBase36ToBigInt(digitsStr);
  if (digits === null) return null;

  const decimal = digits.toString(10);
  if (scale === 0) {
    return decimal;
  }

  const padded = decimal.padStart(scale + 1, "0");
  const intPart = padded.slice(0, -scale) || "0";
  const fracPart = padded.slice(-scale).replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
};

const encodeCreatorId = (creatorId?: string): string | null => {
  if (!creatorId) return null;
  if (/^\d+$/.test(creatorId)) {
    const big = BigInt(creatorId);
    return `n${big.toString(36)}`;
  }
  const encoded = Buffer.from(creatorId, "utf8").toString("base64url");
  return `s${encoded}`;
};

const decodeCreatorId = (encoded: string | undefined): string | null => {
  if (!encoded || encoded.length < 2) return null;
  const mode = encoded.charAt(0);
  const value = encoded.slice(1);

  if (mode === "n") {
    const decoded = decodeBase36ToBigInt(value);
    return decoded !== null ? decoded.toString(10) : null;
  }

  if (mode === "s") {
    // base64url decoding never throws; invalid characters are skipped.
    return Buffer.from(value, "base64url").toString("utf8");
  }

  return null;
};

const buildCallback = (parts: string[]): string | null => {
  if (parts.some((part) => part === "")) return null;
  const payload = parts.join(CALLBACK_SEPARATOR);
  if (Buffer.byteLength(payload, "utf-8") > CALLBACK_DATA_LIMIT) return null;
  return payload;
};

const parseCallbackParts = (
  data: string | undefined,
  expectedPrefix: CallbackPrefix,
  totalParts: number,
): string[] | null => {
  if (!data) return null;
  const parts = data.split(CALLBACK_SEPARATOR);
  if (parts[0] !== expectedPrefix) return null;
  if (parts.length !== totalParts) return null;
  return parts;
};

export type EncodedGameConfirmPayload = {
  gameType: GameType;
  amount: string;
  players: number;
  timeoutSeconds: number;
  minPlayers: number;
  isPrivate: boolean;
  creatorId: string;
};

export const encodeGameConfirmPayload = (payload: EncodedGameConfirmPayload) => {
  const amountPart = encodeAmount(payload.amount);
  const creatorPart = encodeCreatorId(payload.creatorId);
  const playersPart = encodeUnsigned(payload.players);
  const timeoutPart = encodeUnsigned(payload.timeoutSeconds);
  const minPlayersPart = encodeUnsigned(payload.minPlayers);
  const visibilityPart = payload.isPrivate ? "1" : "0";

  if (!amountPart || !creatorPart || !playersPart || !timeoutPart || !minPlayersPart) {
    return null;
  }

  return buildCallback([
    CALLBACK_PREFIX.confirmGame,
    toGameTypeCode(payload.gameType),
    amountPart,
    playersPart,
    timeoutPart,
    minPlayersPart,
    visibilityPart,
    creatorPart,
  ]);
};

export const decodeGameConfirmPayload = (
  data: string | undefined,
): EncodedGameConfirmPayload | null => {
  const parts = parseCallbackParts(data, CALLBACK_PREFIX.confirmGame, 8);
  if (!parts) return null;
  const gameType = fromGameTypeCode(parts[1]!);
  const amount = decodeAmount(parts[2]!);
  const players = decodeUnsigned(parts[3]!);
  const timeoutSeconds = decodeUnsigned(parts[4]!);
  const minPlayers = decodeUnsigned(parts[5]!);
  const isPrivate = parts[6] === "1";
  const creatorId = decodeCreatorId(parts[7]!);

  if (
    !gameType ||
    amount === null ||
    players === null ||
    timeoutSeconds === null ||
    minPlayers === null ||
    !creatorId
  ) {
    return null;
  }

  return {
    gameType,
    amount,
    players,
    timeoutSeconds,
    minPlayers,
    isPrivate,
    creatorId,
  };
};

export type EncodedTimeoutChangePayload = {
  gameType: GameType;
  amount: string;
  players: number;
  deltaMinutes: number;
  creatorId: string;
};

export const encodeTimeoutChangePayload = (payload: EncodedTimeoutChangePayload) => {
  const amountPart = encodeAmount(payload.amount);
  const creatorPart = encodeCreatorId(payload.creatorId);
  const playersPart = encodeUnsigned(payload.players);
  const deltaPart = encodeSigned(payload.deltaMinutes);

  if (!amountPart || !creatorPart || !playersPart || !deltaPart) {
    return null;
  }

  return buildCallback([
    CALLBACK_PREFIX.timeoutChange,
    toGameTypeCode(payload.gameType),
    amountPart,
    playersPart,
    deltaPart,
    creatorPart,
  ]);
};

export const decodeTimeoutChangePayload = (
  data: string | undefined,
): EncodedTimeoutChangePayload | null => {
  const parts = parseCallbackParts(data, CALLBACK_PREFIX.timeoutChange, 6);
  if (!parts) return null;
  const gameType = fromGameTypeCode(parts[1]!);
  const amount = decodeAmount(parts[2]!);
  const players = decodeUnsigned(parts[3]!);
  const deltaMinutes = decodeSigned(parts[4]!);
  const creatorId = decodeCreatorId(parts[5]!);

  if (!gameType || amount === null || players === null || deltaMinutes === null || !creatorId) {
    return null;
  }

  return {
    gameType,
    amount,
    players,
    deltaMinutes,
    creatorId,
  };
};

export type EncodedVisibilityPayload = {
  gameType: GameType;
  amount: string;
  players: number;
  isPrivate: boolean;
  creatorId: string;
};

export const encodeVisibilityPayload = (payload: EncodedVisibilityPayload) => {
  const amountPart = encodeAmount(payload.amount);
  const creatorPart = encodeCreatorId(payload.creatorId);
  const playersPart = encodeUnsigned(payload.players);
  const visibilityPart = payload.isPrivate ? "1" : "0";

  if (!amountPart || !creatorPart || !playersPart) {
    return null;
  }

  return buildCallback([
    CALLBACK_PREFIX.visibility,
    toGameTypeCode(payload.gameType),
    amountPart,
    playersPart,
    visibilityPart,
    creatorPart,
  ]);
};

export const decodeVisibilityPayload = (
  data: string | undefined,
): EncodedVisibilityPayload | null => {
  const parts = parseCallbackParts(data, CALLBACK_PREFIX.visibility, 6);
  if (!parts) return null;
  const gameType = fromGameTypeCode(parts[1]!);
  const amount = decodeAmount(parts[2]!);
  const players = decodeUnsigned(parts[3]!);
  const isPrivate = parts[4] === "1";
  const creatorId = decodeCreatorId(parts[5]!);

  if (!gameType || amount === null || players === null || !creatorId) {
    return null;
  }

  return {
    gameType,
    amount,
    players,
    isPrivate,
    creatorId,
  };
};

export type EncodedMinPlayersChangePayload = {
  gameType: GameType;
  amount: string;
  players: number;
  deltaPlayers: number;
  creatorId: string;
};

export const encodeMinPlayersChangePayload = (payload: EncodedMinPlayersChangePayload) => {
  const amountPart = encodeAmount(payload.amount);
  const creatorPart = encodeCreatorId(payload.creatorId);
  const playersPart = encodeUnsigned(payload.players);
  const deltaPart = encodeSigned(payload.deltaPlayers);

  if (!amountPart || !creatorPart || !playersPart || !deltaPart) {
    return null;
  }

  return buildCallback([
    CALLBACK_PREFIX.minPlayersChange,
    toGameTypeCode(payload.gameType),
    amountPart,
    playersPart,
    deltaPart,
    creatorPart,
  ]);
};

export const decodeMinPlayersChangePayload = (
  data: string | undefined,
): EncodedMinPlayersChangePayload | null => {
  const parts = parseCallbackParts(data, CALLBACK_PREFIX.minPlayersChange, 6);
  if (!parts) return null;
  const gameType = fromGameTypeCode(parts[1]!);
  const amount = decodeAmount(parts[2]!);
  const players = decodeUnsigned(parts[3]!);
  const deltaPlayers = decodeSigned(parts[4]!);
  const creatorId = decodeCreatorId(parts[5]!);

  if (!gameType || amount === null || players === null || deltaPlayers === null || !creatorId) {
    return null;
  }

  return {
    gameType,
    amount,
    players,
    deltaPlayers,
    creatorId,
  };
};

export type EncodedAmountSelectionPayload = {
  gameType: GameType;
  amount: string;
  creatorId: string;
};

export const encodeAmountSelectionPayload = (payload: EncodedAmountSelectionPayload) => {
  const amountPart = encodeAmount(payload.amount);
  const creatorPart = encodeCreatorId(payload.creatorId);

  if (!amountPart || !creatorPart) {
    return null;
  }

  return buildCallback([
    CALLBACK_PREFIX.amountSelection,
    toGameTypeCode(payload.gameType),
    amountPart,
    creatorPart,
  ]);
};

export const decodeAmountSelectionPayload = (
  data: string | undefined,
): EncodedAmountSelectionPayload | null => {
  const parts = parseCallbackParts(data, CALLBACK_PREFIX.amountSelection, 4);
  if (!parts) return null;
  const gameType = fromGameTypeCode(parts[1]!);
  const amount = decodeAmount(parts[2]!);
  const creatorId = decodeCreatorId(parts[3]!);

  if (!gameType || amount === null || !creatorId) {
    return null;
  }

  return {
    gameType,
    amount,
    creatorId,
  };
};

export type EncodedPlayersSelectionPayload = {
  gameType: GameType;
  amount: string;
  players: number;
  creatorId: string;
};

export const encodePlayersSelectionPayload = (payload: EncodedPlayersSelectionPayload) => {
  const amountPart = encodeAmount(payload.amount);
  const creatorPart = encodeCreatorId(payload.creatorId);
  const playersPart = encodeUnsigned(payload.players);

  if (!amountPart || !creatorPart || !playersPart) {
    return null;
  }

  return buildCallback([
    CALLBACK_PREFIX.playersSelection,
    toGameTypeCode(payload.gameType),
    amountPart,
    playersPart,
    creatorPart,
  ]);
};

export const decodePlayersSelectionPayload = (
  data: string | undefined,
): EncodedPlayersSelectionPayload | null => {
  const parts = parseCallbackParts(data, CALLBACK_PREFIX.playersSelection, 5);
  if (!parts) return null;
  const gameType = fromGameTypeCode(parts[1]!);
  const amount = decodeAmount(parts[2]!);
  const players = decodeUnsigned(parts[3]!);
  const creatorId = decodeCreatorId(parts[4]!);

  if (!gameType || amount === null || players === null || !creatorId) {
    return null;
  }

  return {
    gameType,
    amount,
    players,
    creatorId,
  };
};

export type EncodedCustomPlayersPayload = {
  gameType: GameType;
  amount: string;
  creatorId: string;
};

export const encodeCustomPlayersPayload = (payload: EncodedCustomPlayersPayload) => {
  const amountPart = encodeAmount(payload.amount);
  const creatorPart = encodeCreatorId(payload.creatorId);

  if (!amountPart || !creatorPart) {
    return null;
  }

  return buildCallback([
    CALLBACK_PREFIX.customPlayers,
    toGameTypeCode(payload.gameType),
    amountPart,
    creatorPart,
  ]);
};

export const decodeCustomPlayersPayload = (
  data: string | undefined,
): EncodedCustomPlayersPayload | null => {
  const parts = parseCallbackParts(data, CALLBACK_PREFIX.customPlayers, 4);
  if (!parts) return null;
  const gameType = fromGameTypeCode(parts[1]!);
  const amount = decodeAmount(parts[2]!);
  const creatorId = decodeCreatorId(parts[3]!);

  if (!gameType || amount === null || !creatorId) {
    return null;
  }

  return {
    gameType,
    amount,
    creatorId,
  };
};

export const isCallbackSafeLength = (callback: string | undefined | null) => {
  if (!callback) return false;
  return Buffer.byteLength(callback, "utf-8") <= CALLBACK_DATA_LIMIT;
};
