import { describe, expect, test } from "bun:test";
import { isServiceAdminCommand, usage } from "../scripts/service-admin";

describe("service-admin command routing", () => {
  test.each([
    "close-orphaned-games",
    "initialize-referral-token-accounts",
    "show-swap-stats",
    "withdraw-token-fees",
    "sweep-to-sol",
  ])("accepts %s", (command) => {
    expect(isServiceAdminCommand(command)).toBe(true);
    expect(usage()).toContain(`  ${command}`);
  });

  test("rejects chain administration", () => {
    expect(isServiceAdminCommand("disable-game-tokens")).toBe(false);
  });
});
