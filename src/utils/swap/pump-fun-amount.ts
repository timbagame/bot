export interface NormalizePumpFunAmountResult {
  decimalAmount: string;
  probablyRawAmount: boolean;
}

export function normalizePumpFunAmount(
  amount: string,
  decimals: number
): NormalizePumpFunAmountResult {
  const trimmed = amount.trim();

  if (trimmed.length === 0) {
    return { decimalAmount: trimmed, probablyRawAmount: false };
  }

  if (decimals <= 0 || !/^\d+$/.test(trimmed)) {
    return { decimalAmount: trimmed, probablyRawAmount: false };
  }

  try {
    const rawAmount = BigInt(trimmed);
    const divisor = BigInt(10) ** BigInt(decimals);
    const remainder = rawAmount % divisor;
    const whole = rawAmount / divisor;
    const meetsMagnitudeThreshold = rawAmount >= 1_000_000n || remainder === 0n;

    if (!meetsMagnitudeThreshold) {
      return { decimalAmount: trimmed, probablyRawAmount: false };
    }

    if (remainder === 0n) {
      return {
        decimalAmount: whole.toString(),
        probablyRawAmount: true,
      };
    }

    const fractionalRaw = remainder.toString().padStart(decimals, "0");
    const fractionalPart = fractionalRaw.replace(/0+$/, "");
    const leadingZeros = fractionalPart.match(/^0+/)?.[0].length ?? 0;

    if (whole === 0n && leadingZeros >= 4) {
      return { decimalAmount: trimmed, probablyRawAmount: false };
    }

    const decimalAmount =
      fractionalPart.length > 0
        ? `${whole.toString()}.${fractionalPart}`
        : whole.toString();

    return {
      decimalAmount,
      probablyRawAmount: true,
    };
  } catch {
    return { decimalAmount: trimmed, probablyRawAmount: false };
  }
}
