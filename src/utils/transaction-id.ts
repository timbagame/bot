import { randomBytes } from "node:crypto";

const RANDOM_BYTES = 16;

export const generateTransactionId = (): string => {
  const randomSegment = randomBytes(RANDOM_BYTES).toString("base64url");
  return `tx_${Date.now()}_${randomSegment}`;
};
