import { beforeAll, afterAll, test, expect } from "bun:test";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC ||
  "test walk nut penalty hip pave soap entry language right filter choice";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";
const previousPricesEnabled = process.env["PRICES_ENABLED"];
process.env["PRICES_ENABLED"] = "false";

afterAll(() => {
  if (previousPricesEnabled === undefined) {
    process.env["PRICES_ENABLED"] = "true";
    return;
  }

  process.env["PRICES_ENABLED"] = previousPricesEnabled;
});

let bot: any;
let wallet: any;
let __test_setWalletCache: any;
let __test_getCachedWalletData: any;
let __test_clearWalletCache: any;

beforeAll(async () => {
  ({
    bot,
    wallet,
    __test_setWalletCache,
    __test_getCachedWalletData,
    __test_clearWalletCache,
  } = await import("../src/bot"));

  (bot as any).botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
});

test("falls back to stale wallet cache when fresh fetch fails", async () => {
  const telegramId = BigInt(9999);
  const staleSnapshot = {
    solBalance: 123,
    nativeSolBalance: 123,
    wsolBalance: 10,
    tokenBalances: [
      { mint: "mint-a", ticker: "AAA", balance: 1_000_000, decimals: 6, rawBalance: "1000000" },
    ],
    approvedTokens: [],
  };

  __test_setWalletCache(telegramId, staleSnapshot, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const originalGetBalance = wallet.getBalance.bind(wallet);
  const originalGetTokenBalances = wallet.getAllApprovedTokenBalances.bind(wallet);

  wallet.getBalance = async () => {
    throw new Error("RPC down");
  };
  wallet.getAllApprovedTokenBalances = async () => {
    throw new Error("Should not fetch tokens when using stale cache");
  };

  const result = await __test_getCachedWalletData(telegramId);

  expect(result).toMatchObject({
    solBalance: staleSnapshot.solBalance,
    tokenBalances: staleSnapshot.tokenBalances,
  });

  wallet.getBalance = originalGetBalance;
  wallet.getAllApprovedTokenBalances = originalGetTokenBalances;
  __test_clearWalletCache(telegramId);
});

test("throws when no cache available and fetch fails", async () => {
  const telegramId = BigInt(10000);
  __test_clearWalletCache(telegramId);

  const originalGetBalance = wallet.getBalance.bind(wallet);
  wallet.getBalance = async () => {
    throw new Error("RPC still down");
  };

  await expect(__test_getCachedWalletData(telegramId)).rejects.toThrow("RPC still down");

  wallet.getBalance = originalGetBalance;
});
