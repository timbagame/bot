const RANDOM_SEGMENT_LENGTH = 9;

export const generateTransactionId = (): string => {
  return `tx_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 2 + RANDOM_SEGMENT_LENGTH)}`;
};
