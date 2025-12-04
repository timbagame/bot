import { describe, expect, test } from "bun:test";

import type { InlineKeyboardButton } from "grammy/types";

import { createAdvancedOptionsKeyboard } from "../src/utils/keyboards";

const getCallbackData = (button?: InlineKeyboardButton): string | undefined => {
  if (!button) return undefined;
  if ("callback_data" in button) {
    return (button as InlineKeyboardButton.CallbackButton).callback_data;
  }
  return undefined;
};

describe("advanced minimum players controls", () => {
  test("enables adjustments within allowed range", () => {
    const keyboard = createAdvancedOptionsKeyboard(
      "coinflip",
      "1",
      "4",
      { timeoutSeconds: 600, minPlayers: 3, isPrivate: true }
    );

    const minPlayersRow = keyboard.inline_keyboard[2]!;

    expect(getCallbackData(minPlayersRow[0])).toBe(
      "advanced_min_players_coinflip_1_4_-1"
    );
    expect(minPlayersRow[1]?.text).toContain("Min players: 3");
    expect(getCallbackData(minPlayersRow[2])).toBe(
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

    expect(getCallbackData(minPlayersRow[0])).toBe(
      "advanced_min_players_giveaway_0.5_3_-1"
    );
    expect(getCallbackData(minPlayersRow[2])).toBe("noop");
  });
});
