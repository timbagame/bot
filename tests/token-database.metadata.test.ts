import { expect, test, beforeEach } from "bun:test";
import { TokenDatabase } from "../src/utils/token-database";
import { resetTestDatabase } from "./helpers/database";

beforeEach(() => {
  resetTestDatabase("tokens.sqlite");
  // @ts-ignore reset singleton
  TokenDatabase["instance"] = undefined;
});

test("TokenDatabase: metadata CRUD and cleanup", () => {
  const db = TokenDatabase.getInstance();

  db.addKnownToken("mintX", "XXX", 6);
  db.addKnownToken("mintY", "YYY", 9);

  // Metadata save/get
  db.saveTokenMetadata("mintX", "Token X", "XXX", 6, "http://logo/x.png");
  const meta = db.getTokenMetadata("mintX");
  expect(meta?.token_mint).toBe("mintX");
  expect(meta?.symbol).toBe("XXX");

  // get by mint + list all
  const byMint = db.getKnownTokenByMint("mintY");
  expect(byMint?.token_ticker).toBe("YYY");

  const all = db.getAllKnownTokens();
  expect(all.length).toBe(2);

  // Cleanup old metadata (threshold in future so zero deletions)
  const removed = db.cleanupOldMetadata(3650);
  expect(removed).toBe(0);
});
