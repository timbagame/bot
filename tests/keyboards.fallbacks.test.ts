import { describe, expect, test } from "bun:test";
import {
  createGameConfirmKeyboard,
  createPlayerSelectionKeyboard,
  getFeeWarningMessage,
} from "../src/utils/keyboards";
import { decodeGameConfirmPayload, decodeVisibilityPayload } from "../src/utils/callback-data";

const buttons = (kb: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }) =>
  kb.inline_keyboard.flat();

describe("getFeeWarningMessage game type fallback", () => {
  test("labels an empty game type as a generic game", () => {
    const message = getFeeWarningMessage("", 100, 20);
    expect(message).toContain("<b>Select Amount - Game</b>");
  });

  test("labels a non-string game type as a generic game", () => {
    const message = getFeeWarningMessage(undefined as unknown as string, 100, 20);
    expect(message).toContain("<b>Select Amount - Game</b>");
  });

  test("capitalizes a regular game type", () => {
    expect(getFeeWarningMessage("giveaway", 100, 20)).toContain("Select Amount - Giveaway");
  });
});

describe("createGameConfirmKeyboard without a creator", () => {
  test("renders inert callbacks and a plain back-to-amount callback", () => {
    const kb = createGameConfirmKeyboard("coinflip", "30", "4");
    const all = buttons(kb);

    const create = all.find((b) => b.text === "✅ Create Game");
    expect(create?.callback_data).toBe("noop");

    const visibility = all.find((b) => /Private|Public/.test(b.text));
    expect(visibility?.callback_data).toBe("noop");

    const back = all.find((b) => b.text === "← Back to Players");
    expect(back?.callback_data).toBe("amount_coinflip_30");

    const actionable = all
      .map((b) => b.callback_data)
      .filter((cb) => cb !== undefined && cb !== "noop" && cb !== "amount_coinflip_30");
    expect(actionable).toEqual([]);
  });

  test("falls back to the minimum player count when players is not numeric", () => {
    const kb = createGameConfirmKeyboard("coinflip", "30", "not-a-number", "abc");
    const confirm = buttons(kb).find((b) => b.callback_data?.startsWith("cg|"));
    const decoded = decodeGameConfirmPayload(confirm!.callback_data!);
    expect(decoded?.players).toBe(2);
    expect(decoded?.minPlayers).toBe(2);
  });

  test("falls back to the giveaway minimum when players is not numeric", () => {
    const kb = createGameConfirmKeyboard("giveaway", "30", "", "abc");
    const confirm = buttons(kb).find((b) => b.callback_data?.startsWith("cg|"));
    const decoded = decodeGameConfirmPayload(confirm!.callback_data!);
    expect(decoded?.gameType).toBe("giveaway");
    expect(decoded?.players).toBeGreaterThanOrEqual(1);
    expect(decoded?.players).toBe(decoded?.minPlayers);
  });
});

describe("createGameConfirmKeyboard visibility lock", () => {
  test("disables the visibility toggle and forces public when locked", () => {
    const kb = createGameConfirmKeyboard(
      "coinflip",
      "30",
      "4",
      "abc",
      { isPrivate: true },
      {
        lockVisibilityToPublic: true,
      },
    );
    const all = buttons(kb);

    const visibility = all.find((b) => /Private|Public/.test(b.text));
    expect(visibility?.callback_data).toBe("noop");
    expect(visibility?.text).toContain("Public");

    const confirm = all.find((b) => b.callback_data?.startsWith("cg|"));
    expect(decodeGameConfirmPayload(confirm!.callback_data!)?.isPrivate).toBe(false);
  });

  test("keeps a working visibility toggle when unlocked", () => {
    const kb = createGameConfirmKeyboard("coinflip", "30", "4", "abc", { isPrivate: true });
    const visibility = buttons(kb).find((b) => /Private|Public/.test(b.text));
    expect(visibility?.callback_data).not.toBe("noop");
    expect(decodeVisibilityPayload(visibility!.callback_data!)?.creatorId).toBe("abc");
  });
});

describe("createPlayerSelectionKeyboard layout lookup", () => {
  test("renders only the back row for an unknown game type", () => {
    const kb = createPlayerSelectionKeyboard("roulette", "10");
    const all = buttons(kb);
    expect(all.some((b) => b.text.startsWith("👥"))).toBe(false);
    expect(all.length).toBeGreaterThan(0);
  });
});
