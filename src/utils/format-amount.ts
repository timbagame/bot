export type FormatOptions = {
  maxFractionDigits?: number;
  trim?: boolean;
};

export type FormatTokenDisplayOptions = {
  decimals?: number;
};

export type FormatUsdValueOptions = {
  approximate?: boolean;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  fallback?: string;
};

const HTML_ESCAPE_LOOKUP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const str = String(value);
  return str.replace(/[&<>"]/g, (char) => HTML_ESCAPE_LOOKUP[char] ?? char);
}

function toBigIntString(value: number | string | bigint): { sign: string; digits: string } {
  if (typeof value === "bigint") {
    const sign = value < 0n ? "-" : "";
    const digits = (value < 0n ? -value : value).toString();
    return { sign, digits };
  }
  if (typeof value === "number") {
    // value should represent an integer count of smallest units
    const rounded = Math.trunc(value);
    const sign = Object.is(rounded, -0) || rounded < 0 ? "-" : "";
    const digits = Math.abs(rounded).toString();
    return { sign, digits };
  }
  // string
  let s = value.trim();
  let sign = "";
  if (s.startsWith("-")) {
    sign = "-";
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  // ensure it's integer digits
  if (!/^\d+$/.test(s)) {
    // fallback: attempt to parse as number then to integer
    const n = Math.trunc(Number(value));
    const signn = Object.is(n, -0) || n < 0 ? "-" : "";
    const digits = Math.abs(n).toString();
    return { sign: signn, digits };
  }
  // strip leading zeros but leave at least one
  s = s.replace(/^0+(?=\d)/, "");
  return { sign, digits: s };
}

export function formatAmount(
  raw: number | string | bigint,
  decimals: number,
  opts: FormatOptions = {}
): string {
  const { maxFractionDigits = decimals, trim = true } = opts;
  const { sign, digits } = toBigIntString(raw);

  // Pad digits so we can slice integer/fraction reliably
  const needed = Math.max(decimals + 1 - digits.length, 0);
  const padded = (needed > 0 ? "0".repeat(needed) : "") + digits;

  let integerPart = decimals === 0 ? padded : padded.slice(0, -decimals) || "0";
  let fractionalFull = decimals === 0 ? "" : padded.slice(-decimals).padStart(decimals, "0");

  const desired = Math.max(0, Math.min(maxFractionDigits, decimals));

  // Rounding
  if (decimals === 0 || desired === 0) {
    // Round based on first fractional digit if any
    const roundDigit = fractionalFull[0] || "0";
    if (roundDigit >= "5") {
      const inc = (BigInt(integerPart) + 1n).toString();
      integerPart = inc;
    }
    fractionalFull = "";
  }

  let fractionalOut = "";
  if (decimals > 0 && desired > 0) {
    const shown = fractionalFull.slice(0, desired);
    const roundDigit = fractionalFull[desired] || "0";

    if (roundDigit >= "5") {
      const combinedVal = BigInt(integerPart + shown) + 1n;
      const combinedStr = combinedVal.toString();
      const intLen = combinedStr.length - shown.length;
      if (intLen >= 0) {
        integerPart = combinedStr.slice(0, intLen);
        fractionalOut = combinedStr.slice(intLen).padStart(shown.length, "0");
      } else {
        // carry expanded only into fractional part
        integerPart = "0";
        fractionalOut = combinedStr.padStart(shown.length, "0");
      }
    } else {
      fractionalOut = shown;
    }
  }

  // Trim trailing zeros if requested
  if (trim && fractionalOut) {
    fractionalOut = fractionalOut.replace(/0+$/, "");
  }

  const intOut = integerPart === "" ? "0" : integerPart;
  const signed = sign + intOut + (fractionalOut ? "." + fractionalOut : "");
  return signed;
}

export function formatTokenDisplay(
  value: number,
  options: FormatTokenDisplayOptions = {}
): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const decimals =
    typeof options.decimals === "number" && Number.isFinite(options.decimals)
      ? Math.max(0, Math.min(Math.trunc(options.decimals), 6))
      : undefined;

  let precision: number;
  if (decimals !== undefined) {
    precision = decimals;
  } else {
    const [, fractional = ""] = value.toString().split(".");
    const trimmed = fractional.replace(/0+$/, "");
    precision = Math.min(trimmed.length, 6);
  }

  const maximumFractionDigits = precision;
  const minimumFractionDigits = Number.isInteger(value)
    ? 0
    : Math.min(maximumFractionDigits, 6);

  return value.toLocaleString("en-US", {
    minimumFractionDigits,
    maximumFractionDigits,
  });
}

export function formatCompactTokenDisplay(value: string | number): string {
  if (value === null || value === undefined) {
    return "0";
  }

  const rawString = typeof value === "string" ? value : String(value);
  const normalized = rawString.replace(/,/g, "").trim();
  const numeric = Number(normalized);

  if (!Number.isFinite(numeric)) {
    return rawString;
  }

  const sign = numeric < 0 ? "-" : "";
  let absValue = Math.abs(numeric);

  const suffixes = ["", "k", "M", "B", "T", "P", "E"] as const;
  let suffixIndex = 0;

  while (absValue >= 1000 && suffixIndex < suffixes.length - 1) {
    absValue /= 1000;
    suffixIndex += 1;
  }

  if (suffixIndex === 0) {
    if (normalized === "") {
      return "0";
    }

    const [, fractional = ""] = normalized.split(".");
    const trimmedFraction = fractional.replace(/0+$/, "");
    const precision = Math.min(trimmedFraction.length, 6);

    if (precision > 0) {
      return formatTokenDisplay(numeric, { decimals: precision });
    }

    return `${sign}${Math.trunc(Math.abs(numeric)).toLocaleString("en-US")}`;
  }

  const truncated = Math.floor(absValue * 10) / 10;
  let formatted = truncated.toFixed(1);
  formatted = formatted.replace(/\.0$/, "");

  return `${sign}${formatted}${suffixes[suffixIndex]}`;
}

export function formatUsdValue(
  value: number,
  options: FormatUsdValueOptions = {}
): string {
  const {
    approximate = false,
    minimumFractionDigits = 0,
    maximumFractionDigits = 2,
    fallback,
  } = options;

  const formatterOptions = {
    minimumFractionDigits,
    maximumFractionDigits,
  } as const;

  const resolvedFallback =
    fallback ??
    (approximate
      ? `≈ $${(0).toLocaleString("en-US", formatterOptions)}`
      : (0).toLocaleString("en-US", formatterOptions));

  if (!Number.isFinite(value)) {
    return resolvedFallback;
  }

  const formatted = value.toLocaleString("en-US", formatterOptions);

  return approximate ? `≈ $${formatted}` : formatted;
}

export function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }

  let formatted: string;
  if (value >= 1) {
    formatted = value.toFixed(4);
  } else if (value >= 0.01) {
    formatted = value.toFixed(4);
  } else if (value >= 0.0001) {
    formatted = value.toFixed(6);
  } else if (value >= 0.000001) {
    formatted = value.toFixed(8);
  } else if (value >= 0.00000001) {
    formatted = value.toFixed(10);
  } else if (value >= 0.000000000001) {
    formatted = value.toFixed(12);
  } else {
    formatted = value.toExponential(2);
  }

  if (formatted.includes("e")) {
    return formatted;
  }

  return formatted.replace(/0+$/, "").replace(/\.$/, "");
}
