import { expect, test, beforeEach } from "bun:test";
import { TokenDatabase } from "../src/utils/token-database";
import { resetTestDatabase } from "./helpers/database";

beforeEach(() => {
  resetTestDatabase("tokens.sqlite");
  TokenDatabase.resetForTesting();
});

test("TokenDatabase: known tokens CRUD", () => {
  const db = TokenDatabase.getInstance();

  db.addKnownToken("mintX", "XXX", 6);
  db.addKnownToken("mintY", "YYY", 9);

  // get by mint + list all
  const byMint = db.getKnownTokenByMint("mintY");
  expect(byMint?.token_ticker).toBe("YYY");
  expect(byMint?.token_program_id ?? null).toBeNull();

  const all = db.getAllKnownTokens();
  expect(all.length).toBe(2);

  db.setTokenProgramId("mintY", "ProgramId111111111111111111111111111111111111");
  expect(db.getKnownTokenByMint("mintY")?.token_program_id).toBe(
    "ProgramId111111111111111111111111111111111111"
  );

  // Removing one token shrinks list
  db.removeKnownToken("mintX");
  const remaining = db.getAllKnownTokens();
  expect(remaining.map((t) => t.token_mint)).toEqual(["mintY"]);
});
