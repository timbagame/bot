/**
 * Error parsing utilities for extracting structured information from error objects
 */

import type { Connection } from "#solana";

const INSUFFICIENT_LAMPORTS_PATTERN = /insufficient lamports (\d+), need (\d+)/i;

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
  /\b([A-Za-z0-9]{80,88})\b/,
];

export const extractLamportsInfo = (
  errorMessage: string,
): { current: number; needed: number } | null => {
  const match = errorMessage.match(INSUFFICIENT_LAMPORTS_PATTERN);
  if (!match || !match[1] || !match[2]) return null;
  return { current: parseInt(match[1]), needed: parseInt(match[2]) };
};

export const collectErrorLogs = async (
  error: unknown,
  visited: Set<any> = new Set(),
  connection?: Connection,
): Promise<string[]> => {
  if (!error || typeof error !== "object") return [];
  if (visited.has(error)) return [];
  visited.add(error);

  const candidate = error as any;
  const logs: string[] = [];
  const pushLogs = (maybeLogs: unknown) => {
    try {
      if (Array.isArray(maybeLogs)) {
        for (const entry of maybeLogs) {
          if (typeof entry === "string") {
            logs.push(entry);
          }
        }
      }
    } catch (logError) {
      console.debug("Failed to process extracted logs", logError);
    }
  };

  const safePush = (key: string) => {
    try {
      pushLogs(candidate?.[key]);
    } catch (logError) {
      console.debug(`Failed to read ${key} from error`, logError);
    }
  };

  safePush("logs");
  safePush("logMessages");
  safePush("transactionLogs");

  if (connection && typeof candidate.getLogs === "function") {
    try {
      const extracted = await Promise.resolve(candidate.getLogs(connection));
      pushLogs(extracted);
    } catch (logError) {
      console.debug("Failed to extract logs from error", logError);
    }
  }

  const nestedCandidates: unknown[] = [];
  try {
    if (candidate?.data) nestedCandidates.push(candidate.data);
  } catch (nestedError) {
    console.debug("Failed to read data from error", nestedError);
  }
  try {
    if (candidate?.error) nestedCandidates.push(candidate.error);
  } catch (nestedError) {
    console.debug("Failed to read nested error", nestedError);
  }
  try {
    if (candidate?.cause) nestedCandidates.push(candidate.cause);
  } catch (nestedError) {
    console.debug("Failed to read error cause", nestedError);
  }

  for (const nested of nestedCandidates) {
    try {
      const nestedLogs = await collectErrorLogs(nested, visited, connection);
      logs.push(...nestedLogs);
    } catch (nestedError) {
      console.debug("Failed to collect nested logs", nestedError);
    }
  }

  return logs;
};

export const extractLamportsInfoFromError = async (
  error: unknown,
  connection?: Connection,
): Promise<{ current: number; needed: number } | null> => {
  const logs = await collectErrorLogs(error, new Set(), connection);
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
