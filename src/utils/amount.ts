const decimalAmountPattern = /^(?:\d+\.?\d*|\.\d+)$/;

export interface ParseDecimalAmountNumberOptions {
  returnType?: "number";
  allowZero?: boolean;
}

export interface ParseDecimalAmountBigIntOptions {
  returnType: "bigint";
  allowZero?: boolean;
}

type ParseDecimalAmountOptions =
  | ParseDecimalAmountNumberOptions
  | ParseDecimalAmountBigIntOptions;

function assertDecimals(decimals: number): asserts decimals is number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("Decimals must be a non-negative integer");
  }
}

export function parseDecimalAmount(
  value: string,
  decimals: number
): number;
export function parseDecimalAmount(
  value: string,
  decimals: number,
  options: ParseDecimalAmountNumberOptions
): number;
export function parseDecimalAmount(
  value: string,
  decimals: number,
  options: ParseDecimalAmountBigIntOptions
): bigint;
export function parseDecimalAmount(
  value: string,
  decimals: number,
  options: ParseDecimalAmountOptions = {}
): number | bigint {
  assertDecimals(decimals);

  const normalized = value.trim();
  if (!decimalAmountPattern.test(normalized)) {
    throw new Error("Invalid amount format");
  }

  const [intPartRaw = "0", fracPartRaw = ""] = normalized.split(".");
  const intPart = intPartRaw === "" ? "0" : intPartRaw;
  const fraction = decimals > 0
    ? (fracPartRaw + "0".repeat(decimals)).slice(0, decimals)
    : "";

  const base = 10n ** BigInt(decimals);
  const intComponent = BigInt(intPart) * base;
  const fractionComponent = fraction.length > 0 ? BigInt(fraction) : 0n;
  const rawAmount = intComponent + fractionComponent;

  const allowZero = options.allowZero ?? false;
  if (!allowZero && rawAmount === 0n) {
    throw new Error("Amount must be greater than zero");
  }

  if (options.returnType === "bigint") {
    return rawAmount;
  }

  if (rawAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount is too large");
  }

  return Number(rawAmount);
}

export const __test_decimalAmountPattern = decimalAmountPattern;

export type TradeAmountParseResult =
  | { kind: "max" }
  | { kind: "percentage"; percentage: number }
  | { kind: "absolute"; normalized: string };

export const parseTradeAmountInput = (amount: string): TradeAmountParseResult => {
  const trimmed = amount.trim();

  if (!trimmed) {
    throw new Error("Amount cannot be empty");
  }

  const lower = trimmed.toLowerCase();
  if (lower === "max") {
    return { kind: "max" };
  }

  if (trimmed.includes("%")) {
    const percentage = Number.parseFloat(trimmed.replace(/%/g, ""));
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      throw new Error("Invalid percentage format");
    }

    return { kind: "percentage", percentage };
  }

  return { kind: "absolute", normalized: trimmed };
};
