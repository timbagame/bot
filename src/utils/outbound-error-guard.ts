import type { Transformer } from "grammy";

export const GENERIC_USER_ERROR_MESSAGE =
  "❌ Something went wrong. Please try again in a moment. If this keeps happening, contact an admin.";

const EXCEPTION_NAME =
  /\b(?:Aggregate|Assertion|Eval|Internal|ProtocolHttp|ProtocolResponse|Range|Reference|Syntax|Type|URI|Zod)?Error\b|\bException\b/i;
const STACK_FRAME = /(?:^|\n)\s*(?:at\s+(?:async\s+)?\S+|caused by\s*:)/im;
const SOURCE_LOCATION =
  /(?:file:\/\/|\/(?:[^\s/:]+\/)+[^\s/:]+\.(?:[cm]?[jt]sx?|rs|py)):\d+(?::\d+)?/i;
const VALIDATOR_DIAGNOSTIC =
  /\b(?:invalid_type|invalid_union|invalid_value|unrecognized_keys|too_small|too_big)\b|"(?:expected|received|code|path|issues)"\s*:/i;
const NETWORK_DIAGNOSTIC =
  /\b(?:ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_[A-Z_]+)\b/i;
const HTTP_DIAGNOSTIC =
  /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*(?:status\s*)?|status(?:\s+code)?\s*(?:was|is|of|:|=)?\s*)[1-5]\d\d\b|\b(?:Bad Gateway|Gateway Timeout|Internal Server Error|Service Unavailable|Unauthorized)\b/i;
const REQUEST_DIAGNOSTIC =
  /\b(?:request|response|fetch|endpoint)\b[^\n]{0,80}\b(?:failed|failure|invalid|unexpected|unavailable)\b|\b(?:failed|unexpected)\b[^\n]{0,40}\b(?:request|response|status)\b/i;
const SOLANA_DIAGNOSTIC =
  /\b(?:transaction simulation failed|custom program error|instruction error|blockhash not found|failed to send transaction|JSON-RPC|RPC (?:request|response|error))\b/i;
const JUPITER_DIAGNOSTIC =
  /\bJupiter\b[^\n]{0,100}\b(?:error|failed|failure|invalid|missing|request|response|status)\b|\b(?:failed|error)\b[^\n]{0,80}\bJupiter\b/i;

const looksLikeSerializedDiagnostic = (text: string): boolean => {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return false;

    const inspect = (value: unknown, depth = 0): boolean => {
      if (!value || typeof value !== "object" || depth > 5) return false;
      if (Array.isArray(value)) return value.some((entry) => inspect(entry, depth + 1));

      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).map((key) => key.toLowerCase());
      const diagnosticKeys = [
        "cause",
        "code",
        "error",
        "errormessage",
        "issues",
        "message",
        "path",
        "stack",
        "status",
        "statustext",
      ];
      if (keys.some((key) => diagnosticKeys.includes(key))) return true;
      return Object.values(record).some((entry) => inspect(entry, depth + 1));
    };

    return inspect(parsed);
  } catch {
    return false;
  }
};

/**
 * Detect diagnostics by their structure and protocol vocabulary, rather than
 * depending on individual known error sentences.
 */
export const containsRawErrorDetails = (text: string): boolean => {
  if (!text.trim()) return false;

  return (
    looksLikeSerializedDiagnostic(text) ||
    EXCEPTION_NAME.test(text) ||
    STACK_FRAME.test(text) ||
    SOURCE_LOCATION.test(text) ||
    VALIDATOR_DIAGNOSTIC.test(text) ||
    NETWORK_DIAGNOSTIC.test(text) ||
    HTTP_DIAGNOSTIC.test(text) ||
    REQUEST_DIAGNOSTIC.test(text) ||
    SOLANA_DIAGNOSTIC.test(text) ||
    JUPITER_DIAGNOSTIC.test(text)
  );
};

export const guardOutboundText = (text: unknown): unknown =>
  typeof text === "string" && containsRawErrorDetails(text) ? GENERIC_USER_ERROR_MESSAGE : text;

const guardPayloadValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return guardOutboundText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => guardPayloadValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      guardPayloadValue(childValue),
    ]),
  );
};

/**
 * Final defense at the Telegram API boundary, including nested media and inline
 * results. Internal diagnostics remain available in logs.
 */
export const outboundErrorGuard: Transformer = (prev, method, payload, signal) =>
  prev(method, guardPayloadValue(payload) as typeof payload, signal);
