import type { Context } from "grammy";
import { ChatDatabase } from "../../src/utils/chat-database";
import { TokenDatabase } from "../../src/utils/token-database";
import { TokenManager } from "../../src/utils/token-manager";
import { resetTestDatabase } from "./database";

export type ChatType = "private" | "group" | "supergroup";

export type TestContext = Partial<Context> & {
  __calls: any[];
};

export const createTelegramContext = (
  text: string,
  chatType: ChatType = "group",
  overrides: Partial<TestContext> = {},
): TestContext => {
  const calls: any[] = [];
  return {
    from: { id: 1, is_bot: false, username: "alice", first_name: "Alice" } as any,
    chat: { id: 100, type: chatType, title: "test" } as any,
    message: { text, message_id: 1, date: Date.now() / 1000, chat: { id: 100 } } as any,
    reply: async (...args: any[]) => {
      calls.push(["reply", ...args]);
      return { ok: true } as any;
    },
    __calls: calls,
    ...overrides,
  };
};

type WalletStubOverrides = {
  decimals?: number;
  formatTokenBalance?: (amount: number, decimals: number) => string;
  formatSolBalance?: (lamports: number) => string;
  getTokenMetadata?: (mint: string) => Promise<{ decimals: number }>;
  getFullTokenMetadata?: (mint: string) => Promise<{
    decimals: number;
    symbol: string;
    name: string;
  }>;
  getConnection?: () => any;
};

export const createWalletStub = (overrides: WalletStubOverrides = {}): any => {
  const decimals = overrides.decimals ?? 6;
  const formatTokenBalance =
    overrides.formatTokenBalance ??
    ((amount: number, tokenDecimals: number) => {
      const value = amount / Math.pow(10, tokenDecimals);
      return value
        .toFixed(6)
        .replace(/\.0+$/, "")
        .replace(/(\.\d*?)0+$/, "$1");
    });

  return {
    getTokenMetadata: overrides.getTokenMetadata ?? (async (_mint: string) => ({ decimals })),
    getFullTokenMetadata:
      overrides.getFullTokenMetadata ??
      (async (mint: string) => ({
        decimals,
        symbol: "DISC",
        name: `Token ${mint.slice(0, 4).toUpperCase()}`,
      })),
    formatTokenBalance,
    formatSolBalance:
      overrides.formatSolBalance ?? ((lamports: number) => (lamports / 1_000_000_000).toFixed(6)),
    getConnection: overrides.getConnection ?? (() => ({}) as any),
    ...overrides,
  } as any;
};

export const resetTokenManagerState = (): void => {
  resetTestDatabase("chat-settings.sqlite");
  resetTestDatabase("tokens.sqlite");
  ChatDatabase.resetForTesting();
  TokenDatabase.resetForTesting();
  TokenManager.resetForTesting();
};
