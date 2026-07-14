import { describe, expect, test } from "bun:test";
import { isChainAdminCommand, usage } from "../scripts/chain-admin";

describe("chain-admin command routing", () => {
  test.each([
    "initialize-game-tokens",
    "disable-game-tokens",
    "close-orphaned-games",
    "update-oracle",
    "update-token-min-bets",
    "withdraw-token-fees",
    "sweep-to-sol",
  ])("accepts %s", (command) => {
    expect(isChainAdminCommand(command)).toBe(true);
    expect(usage()).toContain(`  ${command}`);
  });

  test("rejects unknown commands", () => {
    expect(isChainAdminCommand("deploy-program")).toBe(false);
  });
});
