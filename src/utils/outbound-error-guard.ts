import type { Transformer } from "grammy";

export const GENERIC_USER_ERROR_MESSAGE =
  "❌ Something went wrong. Please try again in a moment. If this keeps happening, contact an admin.";

const RAW_ERROR_PATTERNS = [
  /(?:^|\n)\s*(?:at\s+\S+|caused by:)/im,
  /\b(?:ZodError|TypeError|SyntaxError|ReferenceError|RangeError|ProtocolHttpError|ProtocolResponseError)\b/,
  /\b(?:invalid_type|invalid_union|unrecognized_keys)\b/,
  /"(?:expected|code|path|message)"\s*:/,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/,
  /^Failed to (?:request|execute) Jupiter\b/i,
  /^Jupiter (?:order|build|execute) (?:failed|error)\b/i,
  /^Failed to\b/i,
  /^Error:\s/i,
];

export const containsRawErrorDetails = (text: string): boolean =>
  RAW_ERROR_PATTERNS.some((pattern) => pattern.test(text));

export const guardOutboundText = (text: unknown): unknown =>
  typeof text === "string" && containsRawErrorDetails(text) ? GENERIC_USER_ERROR_MESSAGE : text;

/**
 * Final defense at the Telegram API boundary. Internal diagnostics still go to
 * logs, but raw exceptions and validator output cannot be sent as text/captions.
 */
export const outboundErrorGuard: Transformer = (prev, method, payload, signal) => {
  if (payload && typeof payload === "object") {
    const guardedPayload = { ...(payload as Record<string, unknown>) };
    if ("text" in guardedPayload) {
      guardedPayload["text"] = guardOutboundText(guardedPayload["text"]);
    }
    if ("caption" in guardedPayload) {
      guardedPayload["caption"] = guardOutboundText(guardedPayload["caption"]);
    }
    return prev(method, guardedPayload as typeof payload, signal);
  }

  return prev(method, payload, signal);
};
