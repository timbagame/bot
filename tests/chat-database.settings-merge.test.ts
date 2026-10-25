import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";

beforeEach(() => {
  resetTestDatabase("chat-settings.sqlite");
  ChatDatabase.resetForTesting();
});

afterEach(() => {
  ChatDatabase.resetForTesting();
  resetTestDatabase("chat-settings.sqlite");
});

describe("ChatDatabase.upsertChatGameSettings merging", () => {
  test("keeps the stored global feed flag when a later update omits it", () => {
    const db = ChatDatabase.getInstance();
    db.upsertChatGameSettings(-2001, { global_public_game_feed: true });
    db.upsertChatGameSettings(-2002, { global_public_game_feed: false });

    const enabled = db.upsertChatGameSettings(-2001, { timeout_seconds: 90 });
    const disabled = db.upsertChatGameSettings(-2002, { timeout_seconds: 45 });

    expect(enabled).toMatchObject({ timeout_seconds: 90, global_public_game_feed: true });
    expect(disabled).toMatchObject({ timeout_seconds: 45, global_public_game_feed: false });
    expect(db.getChatGameSettings(-2001)?.global_public_game_feed).toBeTruthy();
    expect(db.getGlobalPublicGameFeedChatIds()).toEqual([-2001]);
  });

  test("leaves the global feed flag unset when it was never stored", () => {
    const db = ChatDatabase.getInstance();
    db.upsertChatGameSettings(-2003, { timeout_seconds: 30 });

    const merged = db.upsertChatGameSettings(-2003, { coinflip_max_players: 4 });

    expect(merged.global_public_game_feed).toBeNull();
    expect(db.getGlobalPublicGameFeedChatIds()).toEqual([]);
  });
});
