export type FormatOptions = {
  maxFractionDigits?: number;
  trim?: boolean;
};

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
  const { maxFractionDigits = 6, trim = true } = opts;
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
