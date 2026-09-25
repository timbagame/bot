import { expect, test } from "bun:test";
import { evmAccount } from "./wallet";
import { EvmBotStore } from "./store";
import { gameCallback, callbackGame } from "./bot";
const mnemonic = "test test test test test test test test test test test junk";

test("EVM wallet derivation is stable and separated by Telegram identity", () => {
  expect(evmAccount(mnemonic, "101").address).toBe("0xa1d9b614985D5c277c6d59568ca25451604a1b9c");
  expect(evmAccount(mnemonic, "101").address).not.toBe(evmAccount(mnemonic, "102").address);
  for (const id of ["0", "-1", "1.0", "01", ""]) expect(() => evmAccount(mnemonic, id)).toThrow();
});

test("game callbacks fit Telegram's 64 byte limit and round trip full bytes32 IDs", () => {
  const game = `0x${"fe".repeat(32)}` as const;
  const callback = gameCallback("j", game);
  expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64);
  expect(callbackGame(callback.slice(6))).toBe(game);
  expect(() => callbackGame("x")).toThrow();
});

test("confirmed creations atomically produce a durable message and only lock their own wallet", () => {
  const store = new EvmBotStore(":memory:", "31337:proxy");
  const game = `0x${"11".repeat(32)}` as const;
  const action = {
    id: "1",
    user: "101",
    chat: 1,
    message: 2,
    kind: "create" as const,
    body: JSON.stringify({ game }),
    phase: "new" as const,
    raw: null,
    hash: null,
  };
  store.add(action);
  expect(() => store.add({ ...action, id: "2" })).toThrow("awaiting confirmation");
  store.add({ ...action, id: "3", user: "102" });
  store.finish({ ...action, phase: "done" });
  expect(store.messages()).toHaveLength(1);
  expect(store.unnotified().map((row) => row.id)).toEqual(["1"]);
  store.notified("1");
  expect(store.unnotified()).toHaveLength(0);
  store.close();
});

test("network routing preserves canonical syntax, mentions and deep links", async () => {
  const { routeNetworkCommand } = await import("./command-router");
  expect(routeNetworkCommand("/CF@TimbaBot .5 TEST", "TimbaBot", "evm")).toEqual({
    command: "ecf",
    args: ".5 TEST",
  });
  expect(routeNetworkCommand("/cf .5 TEST", "TimbaBot", "solana")).toBeNull();
  expect(routeNetworkCommand("/cf@AnotherBot .5", "TimbaBot", "evm")).toBeNull();
  expect(routeNetworkCommand("/start buy_123", "TimbaBot", "evm")).toBeNull();
  expect(routeNetworkCommand("/withdraw 0x123 .5 TEST", "TimbaBot", "evm")).toEqual({
    command: "ewithdraw",
    args: "TEST .5 0x123",
  });
});

test("network preference changes do not mutate pending actions", () => {
  const store = new EvmBotStore(":memory:", "test");
  expect(store.network("-100")).toBe("solana");
  const pending = {
    id: "1",
    user: "101",
    chat: -100,
    message: 1,
    kind: "join" as const,
    body: "{}",
    phase: "transaction" as const,
    raw: "0x12" as const,
    hash: "0x34" as const,
  };
  store.add(pending);
  store.setNetwork("-100", "evm");
  expect(store.network("-100")).toBe("evm");
  expect(store.network("-200")).toBe("solana");
  store.setNetwork("-100", "solana");
  expect(store.action("1")).toMatchObject(pending);
  expect(store.network("-100")).toBe("solana");
  store.close();
});

test("shared wallet presentation keeps the selected network and supported actions", async () => {
  const { buildWalletCaption } = await import("../utils/wallet-ui");
  const { createWalletKeyboard } = await import("../utils/keyboards");
  const caption = buildWalletCaption(
    "0x123",
    [{ ticker: "TEST", amount: "0.000000000000000001" }],
    { networkName: "Base", explorerUrl: null },
  );
  expect(caption).toContain("Base address");
  expect(caption).toContain("0.000000000000000001");
  expect(caption).not.toContain("solscan");
  const buttons = createWalletKeyboard(undefined, {
    swap: "",
    positions: "",
    withdraw: "withdraw",
    refresh: "refresh",
    settings: "network",
  }).inline_keyboard.flat();
  expect(buttons.map((button) => button.text)).toEqual([
    "💸 Withdraw",
    "🔁 Refresh",
    "⚙️ Settings",
  ]);
});

test("a replay cannot switch spending networks when chat defaults change", () => {
  const store = new EvmBotStore(":memory:", "test");
  expect(store.commandNetwork("100", "chat")).toBe("solana");
  store.setNetwork("chat", "evm");
  expect(store.commandNetwork("100", "chat")).toBe("solana");
  expect(store.commandNetwork("101", "chat")).toBe("evm");
  store.setNetwork("chat", "solana");
  expect(store.commandNetwork("101", "chat")).toBe("evm");
  store.close();
});
