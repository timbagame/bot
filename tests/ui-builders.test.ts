import { describe, expect, test } from "bun:test";
import {
  buildGameConfirmationMessage,
} from "../src/handlers/game-callbacks/ui-builders";

const baseAdvancedState = {
  isPrivate: false,
  minPlayers: 2,
  timeoutSeconds: 0,
};

describe("ui builders", () => {
  test("game confirmation message uses compact duration formatting", () => {
    const message = buildGameConfirmationMessage({
      gameType: "coinflip",
      amount: "1000",
      players: 3,
      tokenTicker: "TIMBA",
      tokenDecimals: 9,
      advanced: { ...baseAdvancedState, timeoutSeconds: 70 * 60 },
    });

    expect(message).toContain("Timeout: <b>1h 10m</b>");
  });
});
