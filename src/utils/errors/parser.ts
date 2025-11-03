/**
 * Error parsing utilities for extracting structured information from error objects
 */

const INSUFFICIENT_LAMPORTS_PATTERN =
  /insufficient lamports (\d+), need (\d+)/i;

const TRANSACTION_TIMEOUT_PATTERNS = [
  "transaction confirmation timeout",
  "transaction was not confirmed",
  "transactionexpiredtimeouterror",
];

const TRANSACTION_EXPIRED_PATTERNS = [
  "transaction expired before confirmation",
  "last valid block height",
];

const SIGNATURE_PATTERNS = [
  /signature ([A-Za-z0-9]{44,})/,
  /Check signature ([A-Za-z0-9]{44,})/,
  /([A-Za-z0-9]{80,88})/,
];

export const extractLamportsInfo = (
  errorMessage: string
): { current: number; needed: number } | null => {
  const match = errorMessage.match(INSUFFICIENT_LAMPORTS_PATTERN);
  if (!match || !match[1] || !match[2]) return null;
  return { current: parseInt(match[1]), needed: parseInt(match[2]) };
};

export const collectErrorLogs = (
  error: unknown,
  visited: Set<any> = new Set()
): string[] => {
  if (!error || typeof error !== "object") return [];
  if (visited.has(error)) return [];
  visited.add(error);

  const candidate = error as any;
  const logs: string[] = [];
  const pushLogs = (maybeLogs: unknown) => {
    if (Array.isArray(maybeLogs)) {
      for (const entry of maybeLogs) {
        if (typeof entry === "string") {
          logs.push(entry);
        }
      }
    }
  };

  pushLogs(candidate.logs);
  pushLogs(candidate.logMessages);
  pushLogs(candidate.transactionLogs);
  if (typeof candidate.getLogs === "function") {
    try {
      const extracted = candidate.getLogs();
      pushLogs(extracted);
    } catch (logError) {
      console.debug("Failed to extract logs from error", logError);
    }
  }

  if (candidate.data) {
    logs.push(...collectErrorLogs(candidate.data, visited));
  }
  if (candidate.error) {
    logs.push(...collectErrorLogs(candidate.error, visited));
  }
  if (candidate.cause) {
    logs.push(...collectErrorLogs(candidate.cause, visited));
  }

  return logs;
};

export const extractLamportsInfoFromError = (
  error: unknown
): { current: number; needed: number } | null => {
  const logs = collectErrorLogs(error);
  for (const log of logs) {
    const info = extractLamportsInfo(log);
    if (info) {
      return info;
    }
  }
  return null;
};

export const isTransactionTimeoutError = (message: string): boolean =>
  TRANSACTION_TIMEOUT_PATTERNS.some((p) => message.includes(p));

export const isTransactionExpiredError = (message: string): boolean =>
  TRANSACTION_EXPIRED_PATTERNS.some((p) => message.includes(p));

export const extractSignature = (errorMessage: string): string | null => {
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
};
