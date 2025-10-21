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
