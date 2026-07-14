import { Keypair, PublicKey } from "@solana/web3.js";
import { GameManager } from "../../src/utils/game";

type WalletStubOptions = {
  blockTime?: number;
  tokenDecimals?: number;
  tokenFormatter?: (amount: number | bigint | string, decimals: number) => string;
};

type DbStubOptions = {
  participants?: string[];
  gameOverride?: Record<string, unknown>;
  playerTelegramByPub?: Record<string, string>;
  displayNameByTelegram?: Record<string, string>;
  usernameToId?: Record<string, string>;
  extra?: Record<string, unknown>;
};

type CtxStubOptions = {
  chatId?: number;
  chatType?: string;
  apiOverrides?: Record<string, any>;
};

export function resetGameManager(): void {
  GameManager.resetForTest();
}

export function makeProgramStub(gameAccount: any = {}): any {
  return {
    account: {
      game: {
        fetch: async () => gameAccount,
      },
    },
  } as any;
}

export function makeWalletStub(options: WalletStubOptions = {}): any {
  const { blockTime = Math.floor(Date.now() / 1000), tokenDecimals = 9, tokenFormatter } = options;

  const formatTokenBalance =
    tokenFormatter ??
    ((amount: number | bigint | string, decimals: number) => {
      const numeric =
        typeof amount === "bigint"
          ? Number(amount)
          : typeof amount === "string"
            ? Number(amount)
            : amount;
      return (numeric / Math.pow(10, decimals)).toFixed(6);
    });

  return {
    getBlockchainTime: async () => blockTime,
    getTokenMetadata: async () => ({ decimals: tokenDecimals }),
    formatTokenBalance,
    formatSolBalance: (amount: number | bigint | string) => formatTokenBalance(amount, 9),
  } as any;
}

export function makeDbStub(options: DbStubOptions = {}): any {
  const {
    participants = [],
    gameOverride = {},
    playerTelegramByPub = {},
    displayNameByTelegram = {},
    usernameToId = {},
    extra = {},
  } = options;

  const normalizeKey = (value: string): string => value.trim().toLowerCase();
  const normalizedUsernameToId: Record<string, string> = {};
  const registerNormalized = (key: string, value: string) => {
    const normalized = normalizeKey(key);
    if (normalized.length === 0) {
      return;
    }
    normalizedUsernameToId[normalized] = value;
  };
  Object.entries(usernameToId).forEach(([key, value]) => {
    registerNormalized(key, value);
    if (key.startsWith("@")) {
      registerNormalized(key.slice(1), value);
    }
  });

  const savedMessages: Array<{ address: string; messageId: number; chatId: number }> = [];
  const clearedMessages: string[] = [];

  const saveUsernameMapping = (
    normalizedUsername: string,
    telegramId: string,
    displayName?: string | null,
  ) => {
    if (!normalizedUsername || !/^\d+$/.test(telegramId)) {
      return;
    }
    const normalized = normalizeKey(normalizedUsername);
    if (normalized.length === 0) {
      return;
    }
    normalizedUsernameToId[normalized] = telegramId;
    usernameToId[normalized] = telegramId;
    usernameToId[`@${normalized}`] = telegramId;
    if (displayName && displayName.trim().length > 0) {
      displayNameByTelegram[telegramId] = displayName.trim();
    }
  };

  const findTelegramIdByNormalizedUsername = (normalizedUsername: string): string | null => {
    if (!normalizedUsername) {
      return null;
    }
    const normalized = normalizeKey(normalizedUsername);
    return normalizedUsernameToId[normalized] ?? null;
  };

  return {
    getGameParticipants: (_addr: string) => participants,
    getGame: (_addr: string) => ({
      token_mint: "MINT",
      token_ticker: "TOK",
      game_type: "coinflip",
      ...gameOverride,
    }),
    getCreatorInfo: (_addr: string) => ({ telegramId: "777" }),
    getPlayerTelegramId: (pub: string) => playerTelegramByPub[pub] || null,
    getPlayerDisplayName: (telegramId: string) => displayNameByTelegram[telegramId] ?? null,
    saveGameMessage: (address: string, messageId: number, chatId: number) => {
      savedMessages.push({ address, messageId, chatId });
    },
    findTelegramIdByUsername: (username: string) => {
      if (typeof username !== "string") {
        return null;
      }
      const trimmed = username.trim();
      if (trimmed.length === 0) {
        return null;
      }
      const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
      const normalized = withoutAt.trim().toLowerCase();
      if (normalized.length === 0) {
        return null;
      }
      const normalizedLookup = findTelegramIdByNormalizedUsername(normalized);
      if (normalizedLookup) {
        return normalizedLookup;
      }
      const direct = usernameToId[normalized];
      if (direct) {
        return direct;
      }
      const withAt = usernameToId["@" + normalized];
      return withAt ?? null;
    },
    saveUsernameMapping,
    findTelegramIdByNormalizedUsername,
    clearGameMessage: (address: string) => {
      clearedMessages.push(address);
    },
    getGameMessages: () => [],
    __savedMessages: savedMessages,
    __clearedMessages: clearedMessages,
    ...extra,
  } as any;
}

export function makeCtxStub(options: CtxStubOptions = {}): any {
  const { chatId = 1, chatType = "private", apiOverrides = {} } = options;
  const calls: any[] = [];
  const ctx: any = {
    chat: { id: chatId, type: chatType },
    __calls: calls,
    api: {
      getChatMember: async (_chat: number, id: number) => ({
        user: { username: `user${id}` },
        status: "member",
      }),
      editMessageCaption: async (...args: any[]) => {
        calls.push(["caption", ...args]);
        return { message_id: 99 };
      },
      editMessageMedia: async (...args: any[]) => {
        calls.push(["media", ...args]);
        return { message_id: 99 };
      },
      editMessageText: async (...args: any[]) => {
        calls.push(["text", ...args]);
        return { message_id: 99 };
      },
      sendMessage: async (...args: any[]) => {
        calls.push(["send", ...args]);
        return { message_id: 777, chat: { id: args[0] } };
      },
      ...apiOverrides,
    },
  };
  return ctx;
}

export function randomGamePublicKey(): PublicKey {
  return Keypair.generate().publicKey;
}
