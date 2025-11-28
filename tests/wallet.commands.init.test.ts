import { expect, test, vi, afterEach } from "bun:test";

vi.mock("../src/handlers/wallet", () => ({
  onBalance: vi.fn(async () => {}),
}));

import { createWalletCommandsModule } from "../src/handlers/wallet-commands";
import type { Context } from "grammy";
import { onBalance } from "../src/handlers/wallet";

class FakeBot {
  public commands = new Map<string, (ctx: any) => Promise<void>>();
  public callbacks = new Map<string, (ctx: any) => Promise<void>>();

  command(names: string | string[], handler: (ctx: any) => Promise<void>): void {
    const list = Array.isArray(names) ? names : [names];
    list.forEach((name) => this.commands.set(name, handler));
  }

  callbackQuery(data: string, handler: (ctx: any) => Promise<void>): void {
    this.callbacks.set(data, handler);
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

const ctxBase: Context = {
  chat: { id: 123, type: "private" } as any,
  message: { message_id: 1 } as any,
  reply: vi.fn(),
  api: {} as any,
  update: {} as any,
} as any;

test("/start calls onChatInitiated and onBalance", async () => {
  const initiated = vi.fn();
  const bot = new FakeBot();

  const mod = createWalletCommandsModule({
    wallet: {} as any,
    getTokenManager: () => ({}) as any,
    getGameManager: () => ({
      primeUsernameCache: vi.fn(),
      findTelegramIdByUsername: vi.fn(),
    }) as any,
    handleCommandError: vi.fn(),
    validateAndProcessTransaction: vi.fn(),
    showWalletUI: vi.fn(),
    clearWalletCache: vi.fn(),
    isPrivateChat: () => true,
    onChatInitiated: initiated,
  });

  mod.registerHandlers(bot as any);

  const start = bot.commands.get("start");
  expect(start).toBeDefined();

  await start!(ctxBase);

  expect(initiated).toHaveBeenCalledWith(123);
  expect(onBalance).toHaveBeenCalledTimes(1);
});

test("start_bot callback triggers initiation", async () => {
  const initiated = vi.fn();
  const bot = new FakeBot();

  const mod = createWalletCommandsModule({
    wallet: {} as any,
    getTokenManager: () => ({}) as any,
    getGameManager: () => ({
      primeUsernameCache: vi.fn(),
      findTelegramIdByUsername: vi.fn(),
    }) as any,
    handleCommandError: vi.fn(),
    validateAndProcessTransaction: vi.fn(),
    showWalletUI: vi.fn(),
    clearWalletCache: vi.fn(),
    isPrivateChat: () => true,
    onChatInitiated: initiated,
  });

  mod.registerHandlers(bot as any);

  const cb = bot.callbacks.get("start_bot");
  expect(cb).toBeDefined();

  await cb!({ ...ctxBase, answerCallbackQuery: vi.fn() });

  expect(initiated).toHaveBeenCalledWith(123);
  expect(onBalance).toHaveBeenCalledTimes(1);
});
