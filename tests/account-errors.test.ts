import { describe, expect, test } from "bun:test";
import { isMissingAccountError } from "../src/utils/account-errors";

describe("missing account detection", () => {
  test("recognizes the adapter's address-qualified error", () => {
    expect(isMissingAccountError(new Error("Account ABC does not exist"))).toBe(true);
  });

  test("recognizes the legacy error wording", () => {
    expect(isMissingAccountError(new Error("Account does not exist"))).toBe(true);
  });

  test("does not classify RPC failures as missing accounts", () => {
    expect(isMissingAccountError(new Error("RPC timeout while fetching account"))).toBe(false);
  });
});
