// Utilities for managing per-user state and pending transactions

const USER_STATE_TIMEOUT = 5 * 60 * 1000; // 5 minutes timeout

type GenericState = { timestamp: number } & Record<string, any>;

const userStates = new Map<string, GenericState>();
const pendingTransactions = new Map<string, GenericState>();

export function setUserState(userId: string, state: Record<string, any>): void {
  const now = Date.now();
  for (const [id, st] of userStates.entries()) {
    if (now - st.timestamp > USER_STATE_TIMEOUT) userStates.delete(id);
  }
  userStates.set(userId, { ...state, timestamp: now });
}

export function getUserState<T = any>(userId: string, clear = false): (T & { timestamp: number }) | undefined {
  const st = userStates.get(userId) as any;
  if (clear && st) userStates.delete(userId);
  return st as any;
}

export function storePendingTransaction(txId: string, transaction: Record<string, any>): void {
  const now = Date.now();
  for (const [id, tx] of pendingTransactions.entries()) {
    if (now - tx.timestamp > USER_STATE_TIMEOUT) pendingTransactions.delete(id);
  }
  pendingTransactions.set(txId, { ...transaction, timestamp: now });
}

export function getPendingTransaction<T = any>(txId: string, remove = true): (T & { timestamp: number }) | undefined {
  const tx = pendingTransactions.get(txId) as any;
  if (remove && tx) pendingTransactions.delete(txId);
  return tx as any;
}

// Test-only helpers
export const __test_getRawUserState = (id: string) => userStates.get(id);
export const __test_clearUserState = (id: string) => userStates.delete(id);
export const __test_getRawPending = (id: string) => pendingTransactions.get(id);

