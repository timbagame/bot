import { expect, test } from "bun:test";
import { TokenDatabase } from "./token-database";
import { rmSync } from "fs";

test("TokenDatabase stores and retrieves known tokens", () => {
  rmSync("tokens.sqlite", { force: true });
  // @ts-ignore - reset singleton for clean test
  TokenDatabase["instance"] = undefined;

  const db = TokenDatabase.getInstance();
  db.addKnownToken("mint1", "AAA", 6);
  db.addKnownToken("mint2", "BBB", 9);

  const found = db.getKnownTokenByTicker("AAA");
  expect(found?.token_mint).toBe("mint1");

  expect(db.getTokenCount()).toBe(2);

  db.removeKnownToken("mint1");
  expect(db.getTokenCount()).toBe(1);
});
