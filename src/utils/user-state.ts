// Utilities for managing per-user state and pending transactions

const USER_STATE_TIMEOUT = 15 * 60 * 1000; // 15 minutes timeout

type GenericState = { timestamp: number } & Record<string, any>;

const pruneExpiredEntries = (
  map: Map<string, GenericState>,
  now: number
): void => {
  for (const [id, state] of map.entries()) {
    if (now - state.timestamp > USER_STATE_TIMEOUT) {
      map.delete(id);
    }
  }
};

const userStates = new Map<string, GenericState>();
const pendingTransactions = new Map<string, GenericState>();

const buildNamespacedKey = (namespace: string, key: string): string =>
  `${namespace}:${key}`;

const stripTimestamp = <T>(state?: GenericState): T | undefined => {
  if (!state) {
    return undefined;
  }

  const { timestamp: _timestamp, ...rest } = state;
  return rest as T;
};

const getNamespacedState = <T>(
  namespace: string,
  key: string,
  clear = false
): T | undefined => {
  const raw = getUserState<T & { timestamp: number }>(
    buildNamespacedKey(namespace, key),
    clear
  );
  return stripTimestamp<T>(raw as unknown as GenericState | undefined);
};

const setNamespacedState = <T>(
  namespace: string,
  key: string,
  state: T
): void => {
  setUserState(buildNamespacedKey(namespace, key), state as GenericState);
};

const clearNamespacedState = (namespace: string, key: string): void => {
  getUserState(buildNamespacedKey(namespace, key), true);
};

const clearNamespace = (namespace: string): void => {
  const prefix = `${namespace}:`;
  for (const key of userStates.keys()) {
    if (key.startsWith(prefix)) {
      userStates.delete(key);
    }
  }
};

export function setUserState(userId: string, state: Record<string, any>): void {
  const now = Date.now();
  pruneExpiredEntries(userStates, now);
  userStates.set(userId, { ...state, timestamp: now });
}

export function getUserState<T = any>(userId: string, clear = false): (T & { timestamp: number }) | undefined {
  const st = userStates.get(userId) as any;
  if (clear && st) userStates.delete(userId);
  return st as any;
}

export function storePendingTransaction(txId: string, transaction: Record<string, any>): void {
  const now = Date.now();
  pruneExpiredEntries(pendingTransactions, now);
  pendingTransactions.set(txId, { ...transaction, timestamp: now });
}

export function getPendingTransaction<T = any>(txId: string, remove = true): (T & { timestamp: number }) | undefined {
  const tx = pendingTransactions.get(txId) as any;
  if (remove && tx) pendingTransactions.delete(txId);
  return tx as any;
}

export type GameSetupSessionState = {
  waitingFor: string;
  gameType: string;
  userBalance: number;
  messageId?: number;
  chatId?: number;
  amount?: string;
  creatorId?: string;
  tokenMint?: string;
  tokenTicker?: string;
  tokenDecimals?: number;
  contractMinimum?: number;
  maxPlayersLimit?: number;
};

const GAME_SETUP_NAMESPACE = "game_setup";

const DEFAULT_GAME_SETUP_SESSION: Pick<
  GameSetupSessionState,
  "waitingFor" | "gameType" | "userBalance"
> = {
  waitingFor: "setup",
  gameType: "",
  userBalance: 0,
};

export const upsertGameSetupSession = (
  key: string,
  updates: Partial<GameSetupSessionState>
): GameSetupSessionState => {
  const existing = getNamespacedState<GameSetupSessionState>(
    GAME_SETUP_NAMESPACE,
    key
  );

  const next: GameSetupSessionState = {
    ...DEFAULT_GAME_SETUP_SESSION,
    ...(existing ?? {}),
    ...updates,
  };

  setNamespacedState(GAME_SETUP_NAMESPACE, key, next);
  return next;
};

export const getGameSetupSession = (
  key: string
): GameSetupSessionState | undefined =>
  getNamespacedState<GameSetupSessionState>(GAME_SETUP_NAMESPACE, key);

export const clearGameSetupSession = (key: string): void => {
  clearNamespacedState(GAME_SETUP_NAMESPACE, key);
};

export const clearAllGameSetupSessions = (): void => {
  clearNamespace(GAME_SETUP_NAMESPACE);
};

export type InputSessionState = {
  type: string;
  messageId?: number;
  chatId?: number;
  [key: string]: unknown;
};

const INPUT_SESSION_NAMESPACE = "input_session";

export const setInputSession = (
  key: string,
  session: InputSessionState
): InputSessionState => {
  setNamespacedState(INPUT_SESSION_NAMESPACE, key, session);
  return session;
};

export const getInputSession = (
  key: string
): InputSessionState | undefined =>
  getNamespacedState<InputSessionState>(INPUT_SESSION_NAMESPACE, key);

export const clearInputSession = (key: string): void => {
  clearNamespacedState(INPUT_SESSION_NAMESPACE, key);
};

export const clearAllInputSessions = (): void => {
  clearNamespace(INPUT_SESSION_NAMESPACE);
};

const listNamespaceEntries = <T>(namespace: string): Array<[string, T]> => {
  pruneExpiredEntries(userStates, Date.now());
  const prefix = `${namespace}:`;
  const results: Array<[string, T]> = [];

  for (const [key, value] of userStates.entries()) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    const stripped = stripTimestamp<T>(value);
    if (stripped) {
      results.push([key.slice(prefix.length), stripped]);
    }
  }

  return results;
};

export const __test_listGameSetupSessions = () =>
  listNamespaceEntries<GameSetupSessionState>(GAME_SETUP_NAMESPACE);

export const __test_listInputSessions = () =>
  listNamespaceEntries<InputSessionState>(INPUT_SESSION_NAMESPACE);

// Test-only helpers
export const __test_getRawUserState = (id: string) => userStates.get(id);
export const __test_clearUserState = (id: string) => userStates.delete(id);
export const __test_getRawPending = (id: string) => pendingTransactions.get(id);
