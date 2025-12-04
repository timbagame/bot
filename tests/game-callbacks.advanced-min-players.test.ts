import { describe, expect, test } from "bun:test";

import { createAdvancedOptionsKeyboard } from "../src/utils/keyboards";

describe("advanced minimum players controls", () => {
  test("enables adjustments within allowed range", () => {
    const keyboard = createAdvancedOptionsKeyboard(
      "coinflip",
      "1",
      "4",
      { timeoutSeconds: 600, minPlayers: 3, isPrivate: true }
    );

    const minPlayersRow = keyboard.inline_keyboard[2]!;

    expect(minPlayersRow[0]?.callback_data).toBe(
      "advanced_min_players_coinflip_1_4_-1"
    );
    expect(minPlayersRow[1]?.text).toContain("Min players: 3");
    expect(minPlayersRow[2]?.callback_data).toBe(
      "advanced_min_players_coinflip_1_4_1"
    );
  });

  test("disables increment when already at the selected player count", () => {
    const keyboard = createAdvancedOptionsKeyboard(
      "giveaway",
      "0.5",
      "3",
      { timeoutSeconds: 600, minPlayers: 3, isPrivate: false }
    );

    const minPlayersRow = keyboard.inline_keyboard[2]!;

    expect(minPlayersRow[0]?.callback_data).toBe(
      "advanced_min_players_giveaway_0.5_3_-1"
    );
    expect(minPlayersRow[2]?.callback_data).toBe("noop");
  });
});
