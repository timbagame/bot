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
  extra?: Record<string, unknown>;
};

type CtxStubOptions = {
  chatId?: number;
  chatType?: string;
  apiOverrides?: Record<string, any>;
};

export function resetGameManager(): void {
  // @ts-ignore
  GameManager["instance"] = undefined;
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
  const {
    blockTime = Math.floor(Date.now() / 1000),
    tokenDecimals = 9,
    tokenFormatter,
  } = options;

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
    formatSolBalance: (amount: number | bigint | string) =>
      formatTokenBalance(amount, 9),
  } as any;
}

export function makeDbStub(options: DbStubOptions = {}): any {
  const {
    participants = [],
    gameOverride = {},
    playerTelegramByPub = {},
    displayNameByTelegram = {},
    extra = {},
  } = options;

  const savedMessages: Array<{ address: string; messageId: number; chatId: number }> = [];
  const clearedMessages: string[] = [];

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
    getPlayerDisplayName: (telegramId: string) =>
      displayNameByTelegram[telegramId] ?? null,
    saveGameMessage: (address: string, messageId: number, chatId: number) => {
      savedMessages.push({ address, messageId, chatId });
    },
    clearGameMessage: (address: string) => {
      clearedMessages.push(address);
    },
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
