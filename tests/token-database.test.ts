import { expect, test } from "bun:test";
import { TokenDatabase } from "../src/utils/token-database";
import { resetTestDatabase } from "./helpers/database";

test("TokenDatabase stores and retrieves known tokens", () => {
  resetTestDatabase("tokens.sqlite");
  TokenDatabase.resetForTesting();

  const db = TokenDatabase.getInstance();
  db.addKnownToken("mint1", "AAA", 6);
  db.addKnownToken("mint2", "BBB", 9);

  const found = db.getKnownTokenByTicker("AAA");
  expect(found?.token_mint).toBe("mint1");

  expect(db.getTokenCount()).toBe(2);

  db.removeKnownToken("mint1");
  expect(db.getTokenCount()).toBe(1);
});
