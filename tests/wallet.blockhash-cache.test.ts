import { expect, test } from "bun:test";
import type { Connection } from "#solana";
import { WalletManager } from "../src/utils/wallet";
import { WSOL_MINT } from "../src/utils/constants";

const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class FakeConnection implements Partial<Connection> {
  private i = 0;
  async getLatestBlockhash() {
    this.i += 1;
    return { blockhash: `BH_${this.i}`, lastValidBlockHeight: 1000 + this.i } as any;
  }
}

test("getLatestBlockhash caches within TTL", async () => {
  // Inject fake connection/time
  let now = Date.now();
  const realNow = Date.now;
  // Monkey-patch Date.now so internal cache uses our clock
  // @ts-ignore
  Date.now = () => now;
  const conn = new FakeConnection() as any as Connection;
  const wm = WalletManager.createForTest(mnemonic, {
    connection: conn,
    fetch: globalThis.fetch as any,
    timeNow: () => now,
  });

  const a = await wm.getLatestBlockhash();
  const b = await wm.getLatestBlockhash();
  expect(a.blockhash).toBe(b.blockhash); // cached

  // Advance time beyond cache TTL (10s)
  now += 11_000;
  const c = await wm.getLatestBlockhash();
  expect(c.blockhash).not.toBe(a.blockhash);
  // restore Date.now
  Date.now = realNow;
});

test("getTokenMetadata uses known token shortcuts", async () => {
  const conn = new FakeConnection() as any as Connection;
  const wm = WalletManager.createForTest(mnemonic, {
    connection: conn,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
    tokenMetadataResolver: (mint) => (mint === WSOL_MINT ? { decimals: 9 } : null),
  });
  const wsol = await wm.getTokenMetadata("So11111111111111111111111111111111111111112");
  expect(wsol.decimals).toBe(9);
});
