import { describe, expect, test } from "bun:test";

import { resolveAdvancedOptions, resolveGamePrivacy } from "../src/utils/game-settings";
import type { ChatGameSettings } from "../src/types";

const chat = (privacy: Partial<ChatGameSettings>): ChatGameSettings => ({
  chat_id: 1,
  updated_at: 0,
  ...privacy,
});

describe("resolveGamePrivacy", () => {
  describe("with no chat settings", () => {
    test.each([undefined, null, {}] as (ChatGameSettings | null | undefined)[])(
      "coinflips are public and giveaways private (%p)",
      (settings) => {
        expect(resolveGamePrivacy("coinflip", settings)).toBe(false);
        expect(resolveGamePrivacy("giveaway", settings)).toBe(true);
      },
    );

    test("a null stored privacy counts as unset", () => {
      const settings = chat({ coinflip_default_privacy: null, giveaway_default_privacy: null });
      expect(resolveGamePrivacy("coinflip", settings)).toBe(false);
      expect(resolveGamePrivacy("giveaway", settings)).toBe(true);
    });
  });

  describe("each game type reads only its own setting", () => {
    test("coinflip ignores the giveaway setting", () => {
      expect(resolveGamePrivacy("coinflip", chat({ giveaway_default_privacy: "private" }))).toBe(
        false,
      );
      expect(resolveGamePrivacy("coinflip", chat({ giveaway_default_privacy: "public" }))).toBe(
        false,
      );
    });

    test("giveaway ignores the coinflip setting", () => {
      expect(resolveGamePrivacy("giveaway", chat({ coinflip_default_privacy: "public" }))).toBe(
        true,
      );
      expect(resolveGamePrivacy("giveaway", chat({ coinflip_default_privacy: "private" }))).toBe(
        true,
      );
    });
  });

  describe("an explicit setting wins over the default", () => {
    test.each([
      ["coinflip", "private", true],
      ["coinflip", "public", false],
      ["giveaway", "private", true],
      ["giveaway", "public", false],
    ] as const)("%s set to %s is private=%p", (gameType, privacy, expected) => {
      const settings = chat({
        coinflip_default_privacy: gameType === "coinflip" ? privacy : "public",
        giveaway_default_privacy: gameType === "giveaway" ? privacy : "private",
      });
      expect(resolveGamePrivacy(gameType, settings)).toBe(expected);
    });

    test("both settings together, each game takes its own", () => {
      const settings = chat({
        coinflip_default_privacy: "private",
        giveaway_default_privacy: "public",
      });
      expect(resolveGamePrivacy("coinflip", settings)).toBe(true);
      expect(resolveGamePrivacy("giveaway", settings)).toBe(false);
    });
  });

  test("anything that is not exactly public is private", () => {
    const settings = chat({ coinflip_default_privacy: "friends" as never });
    expect(resolveGamePrivacy("coinflip", settings)).toBe(true);
  });
});

describe("resolveAdvancedOptions privacy", () => {
  test("the session choice beats the chat default, both ways", () => {
    const settings = chat({
      coinflip_default_privacy: "private",
      giveaway_default_privacy: "public",
    });
    expect(
      resolveAdvancedOptions("coinflip", 2, { isPrivate: false }, undefined, settings).isPrivate,
    ).toBe(false);
    expect(
      resolveAdvancedOptions("giveaway", 5, { isPrivate: true }, undefined, settings).isPrivate,
    ).toBe(true);
  });

  test("without a session choice, the chat default applies", () => {
    const settings = chat({ giveaway_default_privacy: "public" });
    expect(resolveAdvancedOptions("giveaway", 5, undefined, undefined, settings).isPrivate).toBe(
      false,
    );
    expect(resolveAdvancedOptions("coinflip", 2, undefined, undefined, settings).isPrivate).toBe(
      false,
    );
  });
});
