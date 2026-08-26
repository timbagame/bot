import "./setup-env";
import { beforeEach, expect, test } from "bun:test";
import { createWalletTransactionsModule } from "../src/handlers/wallet-transactions";
import type { RegisterCallbackPrefixHandler } from "../src/utils/callback-registry";

type CapturedHandler = Parameters<RegisterCallbackPrefixHandler>[1];

let wrapAmountHandler: CapturedHandler | undefined;
let sendAmountHandler: CapturedHandler | undefined;
let cachedWalletError: Error | undefined;

beforeEach(() => {
  wrapAmountHandler = undefined;
  sendAmountHandler = undefined;
  cachedWalletError = undefined;

  const botStub: any = {
    on: () => {},
    callbackQuery: () => {},
  };

  const walletStub: any = {
    formatSolBalance: (lamports: number) => `${lamports / 1_000_000_000} SOL`,
    formatTokenBalance: (value: number, decimals: number) =>
      (value / Math.pow(10, decimals)).toString(),
    getBalance: async () => 5_000_000_000,
    getTokenBalance: async () => 0,
    getKeyPair: () => ({
      publicKey: { toBase58: () => "WRAP111111111111111111111111111111111111" },
    }),
  };

  try {
    const module = createWalletTransactionsModule({
      bot: botStub,
      wallet: walletStub,
      registerWalletActionMenuHandler: () => {},
      registerCallbackPrefixHandler: (prefix, handler) => {
        if (prefix === "wrap_amount_") {
          wrapAmountHandler = handler;
        } else if (prefix === "send_amount_") {
          sendAmountHandler = handler;
        }
      },
      defaultWalletActionMenuDeps: {
        requireTelegramId: () => 99n,
        getWalletAddress: () => "WALLET111111111111111111111111111111111111",
        getWalletBalances: async () => ({
          solBalance: 5_000_000_000,
          tokenBalances: [],
        }),
        formatSolBalance: (lamports: number) => `${lamports / 1_000_000_000} SOL`,
        formatTokenBalance: (balance: number, decimals: number) =>
          (balance / Math.pow(10, decimals)).toString(),
      },
      getCachedWalletData: async () => {
        if (cachedWalletError) throw cachedWalletError;
        return {
          solBalance: 5_000_000_000,
          nativeSolBalance: 5_000_000_000,
          wsolBalance: 0,
          tokenBalances: [],
          knownTokens: [],
        };
      },
      clearWalletCache: () => {},
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getSolFeeBufferLamports: () => 0,
    });
    module.registerHandlers();
  } catch (error) {
    console.error("wallet-transactions module setup failed", error);
  }
});

const createCallbackContext = () => {
  const answered: string[] = [];
  const ctx: any = {
    callbackQuery: { data: "callback", id: "cb-1" },
    from: { id: 777 },
    chat: { id: 42, type: "private" },
    answerCallbackQuery: async (text?: string) => {
      answered.push(text ?? "");
      return { ok: true };
    },
  };
  return { answered, ctx };
};

test("wrap amount handler gracefully rejects empty payloads", async () => {
  expect(typeof wrapAmountHandler).toBe("function");

  const answered: string[] = [];

  const ctx: any = {
    callbackQuery: { data: "wrap_amount_", id: "cb-1" },
    from: { id: 777 },
    chat: { id: 42, type: "private" },
    answerCallbackQuery: async (text?: string) => {
      answered.push(text ?? "");
      return { ok: true };
    },
  };

  await wrapAmountHandler?.(ctx, { raw: "wrap_amount_", payload: "" }, async () => {});

  expect(answered).toHaveLength(1);
  expect(answered[0]).toBe("❌ Amount cannot be empty");
});

test("wrap amount catch does not emit opaque diagnostics", async () => {
  const opaque = "database credential xyz exploded";
  cachedWalletError = new Error(opaque);
  const { answered, ctx } = createCallbackContext();

  await wrapAmountHandler?.(ctx, { raw: "wrap_amount_50%", payload: "50%" }, async () => {});

  expect(answered).toEqual(["❌ Error processing wrap amount"]);
  expect(answered.join(" ")).not.toContain(opaque);
});

test("send amount catch does not emit opaque diagnostics", async () => {
  const opaque = "database credential xyz exploded";
  cachedWalletError = new Error(opaque);
  const { answered, ctx } = createCallbackContext();

  await sendAmountHandler?.(
    ctx,
    { raw: "send_amount_SOL_50%", payload: "SOL_50%" },
    async () => {},
  );

  expect(answered).toEqual(["❌ Error processing amount"]);
  expect(answered.join(" ")).not.toContain(opaque);
});
