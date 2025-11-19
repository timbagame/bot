import { formatAmount } from "./format-amount";

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

export function parseDecimalAmount(value: string, decimals: number): number;
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
  const fraction =
    decimals > 0 ? (fracPartRaw + "0".repeat(decimals)).slice(0, decimals) : "";

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

export type TradeAmountParseResult =
  | { kind: "max" }
  | { kind: "percentage"; percentage: number }
  | { kind: "absolute"; normalized: string };

export const parseTradeAmountInput = (
  amount: string
): TradeAmountParseResult => {
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

export interface TradeTokenBalanceSnapshot {
  balance: number;
  decimals: number;
}

export interface EvaluateTradeAmountParams {
  amount: string;
  assetTicker: string;
  decimals: number;
  solBalance: number;
  tokenBalance?: TradeTokenBalanceSnapshot;
  applySolFeeBuffer?: boolean;
  solFeeBufferLamports?: number;
  insufficientSolForFeesMessage?: string;
  insufficientSolBalanceMessage?: string;
  formatSol?: (lamports: number) => string;
  formatToken?: (amount: number, decimals: number) => string;
  omitSolFeeBufferHint?: boolean;
  userSolBufferLamports?: number;
  insufficientSolMaxBufferMessage?: string;
}

export interface EvaluateTradeAmountResult {
  kind: "max" | "percentage" | "absolute";
  rawAmount: number;
  displayAmount?: string;
  normalizedAmount?: string;
}

export const evaluateTradeAmount = ({
  amount,
  assetTicker,
  decimals,
  solBalance,
  tokenBalance,
  applySolFeeBuffer = false,
  solFeeBufferLamports = 0,
  insufficientSolForFeesMessage = "Not enough SOL to cover purchase and fees",
  insufficientSolBalanceMessage = applySolFeeBuffer
    ? "Insufficient SOL balance for this purchase"
    : "Insufficient SOL balance",
  omitSolFeeBufferHint = false,
  formatSol,
  formatToken,
  userSolBufferLamports = 0,
  insufficientSolMaxBufferMessage,
}: EvaluateTradeAmountParams): EvaluateTradeAmountResult => {
  const parsed = parseTradeAmountInput(amount);
  const isSolAsset = assetTicker === "SOL";

  const ensureTokenBalance = (): TradeTokenBalanceSnapshot => {
    if (!tokenBalance || tokenBalance.balance <= 0) {
      throw new Error(`No ${assetTicker} balance found`);
    }
    return tokenBalance;
  };

  let cachedTokenBalance: TradeTokenBalanceSnapshot | null = null;
  const getTokenSnapshot = (): TradeTokenBalanceSnapshot => {
    if (cachedTokenBalance) {
      return cachedTokenBalance;
    }
    cachedTokenBalance = ensureTokenBalance();
    return cachedTokenBalance;
  };

  const resolveSolSpendable = (): number => {
    const spendable = applySolFeeBuffer
      ? Math.max(0, solBalance - solFeeBufferLamports)
      : solBalance;

    if (spendable <= 0) {
      const bufferHint =
        applySolFeeBuffer &&
        solFeeBufferLamports > 0 &&
        !omitSolFeeBufferHint
          ? ` (keep ~${
              formatSol?.(solFeeBufferLamports) ??
              `${solFeeBufferLamports} lamports`
            } for fees)`
          : "";
      throw new Error(`${insufficientSolForFeesMessage}${bufferHint}`);
    }

    return spendable;
  };

  const formatDisplayAmount = (rawAmount: number): string | undefined => {
    if (isSolAsset) {
      return formatSol ? formatSol(rawAmount) : undefined;
    }

    const { decimals: tokenDecimals } = getTokenSnapshot();
    return formatToken ? formatToken(rawAmount, tokenDecimals) : undefined;
  };

  if (parsed.kind === "max") {
    if (isSolAsset) {
      const spendableLamports = resolveSolSpendable();
      const bufferLamports = Math.max(0, userSolBufferLamports ?? 0);
      const availableLamports = Math.max(0, spendableLamports - bufferLamports);

      if (bufferLamports >= spendableLamports || availableLamports <= 0) {
        const formattedBuffer =
          formatSol?.(bufferLamports) ?? `${bufferLamports} lamports`;
        throw new Error(
          insufficientSolMaxBufferMessage ??
            `Not enough SOL to keep ${formattedBuffer} as a safety buffer when using max amount`
        );
      }

      return {
        kind: "max",
        rawAmount: availableLamports,
        displayAmount: formatDisplayAmount(availableLamports),
        normalizedAmount: "max",
      };
    }

    const tokenSnapshot = getTokenSnapshot();
    const rawAmount = Math.floor(tokenSnapshot.balance);

    if (rawAmount <= 0) {
      throw new Error(`No ${assetTicker} balance found`);
    }

    return {
      kind: "max",
      rawAmount,
      displayAmount: formatDisplayAmount(rawAmount),
      normalizedAmount: "max",
    };
  }

  if (parsed.kind === "percentage") {
    const fraction = parsed.percentage / 100;

    if (isSolAsset) {
      const spendableLamports = resolveSolSpendable();
      const rawAmount = Math.floor(spendableLamports * fraction);

      if (rawAmount <= 0) {
        throw new Error("Percentage results in zero amount");
      }

      const formatted = formatAmount(rawAmount, decimals, {
        maxFractionDigits: decimals,
        trim: true,
      });

      return {
        kind: "percentage",
        rawAmount,
        displayAmount: formatDisplayAmount(rawAmount),
        normalizedAmount: formatted,
      };
    }

    const tokenSnapshot = getTokenSnapshot();
    const rawAmount = Math.floor(tokenSnapshot.balance * fraction);

    if (rawAmount <= 0) {
      throw new Error("Percentage results in zero amount");
    }

    const formatted = formatAmount(rawAmount, tokenSnapshot.decimals, {
      maxFractionDigits: tokenSnapshot.decimals,
      trim: true,
    });

    const displayOverride = formatDisplayAmount(rawAmount);
    const displayAmount = displayOverride ?? formatted;

    return {
      kind: "percentage",
      rawAmount,
      displayAmount,
      normalizedAmount: formatted,
    };
  }

  const rawAmount = parseDecimalAmount(parsed.normalized, decimals, {
    returnType: "number",
  });

  if (isSolAsset) {
    const feeBuffer = applySolFeeBuffer ? solFeeBufferLamports : 0;
    if (rawAmount + feeBuffer > solBalance) {
      throw new Error(insufficientSolBalanceMessage);
    }

    return {
      kind: "absolute",
      rawAmount,
      displayAmount: formatDisplayAmount(rawAmount),
      normalizedAmount: parsed.normalized,
    };
  }

  const tokenSnapshot = getTokenSnapshot();
  if (rawAmount > tokenSnapshot.balance) {
    throw new Error("Insufficient token balance");
  }

  return {
    kind: "absolute",
    rawAmount,
    displayAmount: formatDisplayAmount(rawAmount),
    normalizedAmount: parsed.normalized,
  };
};

export interface PresentedTradeAmountResult {
  kind: EvaluateTradeAmountResult["kind"];
  rawAmount: number;
  normalizedAmount: string;
  displayAmount: string;
}

export const presentTradeAmount = (
  params: EvaluateTradeAmountParams
): PresentedTradeAmountResult => {
  const evaluation = evaluateTradeAmount(params);

  const decimalsForFallback =
    params.assetTicker === "SOL"
      ? params.decimals
      : params.tokenBalance?.decimals ?? params.decimals;

  const fallbackFormatted = formatAmount(
    evaluation.rawAmount,
    decimalsForFallback,
    {
      maxFractionDigits: decimalsForFallback,
      trim: true,
    }
  );

  const normalizedAmount =
    evaluation.normalizedAmount ??
    (evaluation.kind === "max" ? "max" : fallbackFormatted);

  let displayAmount = evaluation.displayAmount;
  if (!displayAmount) {
    if (evaluation.kind === "max" && normalizedAmount === "max") {
      displayAmount = "max";
    } else if (params.assetTicker === "SOL") {
      displayAmount =
        params.formatSol?.(evaluation.rawAmount) ?? fallbackFormatted;
    } else {
      displayAmount =
        params.formatToken?.(evaluation.rawAmount, decimalsForFallback) ??
        fallbackFormatted;
    }
  }

  return {
    kind: evaluation.kind,
    rawAmount: evaluation.rawAmount,
    normalizedAmount,
    displayAmount,
  };
};
