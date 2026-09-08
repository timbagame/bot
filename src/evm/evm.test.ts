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
