import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  answers,
  bot,
  botModule,
  buttons,
  callsTo,
  failApiMethod,
  lastCall,
  lastMessage,
  lastText,
  overrideApiMethod,
  press,
  resetCalls,
  sendText,
  texts,
  useBotHarness,
} from "./helpers/bot-harness";

useBotHarness();

let USER = 98_000;
const GROUP = -9_800;
let manager: any;
let savedManager: any;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let updateId = 94_000_000;

const listing = (n: number) => ({
  messageText: `Game ${n}`,
  keyboard: [[{ text: `Join ${n}`, callback_data: `join_${n}` }]],
  gameAddress: `Game${n}`,
});
const listings = (count: number) => Array.from({ length: count }, (_, i) => listing(i + 1));
const history = (won = 0, lost = 0, cancelled = 0) => ({
  won: { games: listings(won) },
  lost: { games: listings(lost) },
  cancelled: { games: listings(cancelled) },
});

beforeEach(() => {
  USER += 1;
  resetCalls();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  savedManager = botModule.__test_getGameManager();
  manager = {
    getChatActiveGames: mock(async () => []),
    getUserActiveGames: mock(async () => []),
    getActivePublicGamesPage: mock(async () => ({ games: [], totalGames: 0, page: 0 })),
    getUserGamesHistory: mock(async () => history()),
    formatGamesMessage: mock(
      (name: string, _result: unknown, tab: string, page: number) => `${name}:${tab}:${page}`,
    ),
    buildGamesKeyboard: mock((owner: string, _result: unknown, tab: string, page: number) => [
      [{ text: "Won", callback_data: `games_tab:won:${page}:${owner}` }],
      [{ text: `tab ${tab}`, callback_data: `games_refresh:${owner}` }],
    ]),
  };
  botModule.__test_setGameManager(manager as any);
});

afterEach(() => {
  botModule.__test_setGameManager(savedManager);
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

/** A command sent on behalf of a channel/anonymous admin (no `from`). */
const sendAnonymous = (text: string) =>
  bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: GROUP, type: "supergroup", title: "Group" },
      sender_chat: { id: GROUP, type: "supergroup", title: "Group" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
    },
  } as any);

describe("/help", () => {
  test("lists games, wallet and chat commands", async () => {
    const id = await sendText("/help", { userId: USER });

    const reply = lastCall("sendMessage")!;
    expect(reply.payload.parse_mode).toBe("HTML");
    expect(reply.payload.reply_to_message_id).toBe(id);
    for (const command of ["/coinflip", "/active", "/public", "/withdraw", "/tip", "/settings"]) {
      expect(reply.payload.text).toContain(command);
    }
  });
});

describe("/settings", () => {
  test("opens the chat settings summary in groups", async () => {
    overrideApiMethod("getChatMember", (payload) => ({
      status: "administrator",
      user: { id: payload.user_id },
    }));

    const savedTokens = botModule.__test_getTokenManager();
    botModule.__test_setTokenManager({
      getChatDefaultToken: () => null,
      getDefaultToken: () => ({ tokenMint: "TimbaMint", tokenTicker: "TIMBA", decimals: 6 }),
    } as any);
    try {
      await sendText("/settings", { userId: USER, chatId: GROUP });
    } finally {
      botModule.__test_setTokenManager(savedTokens);
    }
    expect(lastText()).toContain("<b>⚙️ Chat settings</b>");
    expect(lastText()).toContain("🪙 Token: TIMBA");
  });

  test("anonymous admins are ignored", async () => {
    await sendAnonymous("/settings");
    expect(texts()).toHaveLength(0);
  });
});

describe("/active", () => {
  test("in a group lists that chat's games with pagination", async () => {
    manager.getChatActiveGames!.mockImplementation(async () => listings(6));

    await sendText("/active", { userId: USER, chatId: GROUP });

    expect(manager.getChatActiveGames!.mock.calls[0]?.[1]).toBe(GROUP);
    expect(lastText()).toBe("🎮 Active games (6) • Page 1/2");
    expect(buttons(lastMessage()).map((button) => button.data)).toContain("active_page:1");
  });

  test("in a group without games says so", async () => {
    await sendText("/active", { userId: USER, chatId: GROUP });
    expect(lastText()).toBe("No active games in this chat.");
  });

  test("in private lists the user's own games", async () => {
    manager.getUserActiveGames!.mockImplementation(async () => [
      { ...listing(1), keyboard: undefined },
    ]);

    await sendText("/active", { userId: USER });

    expect(manager.getUserActiveGames!.mock.calls[0]?.[1]).toBe(BigInt(USER));
    expect(lastText()).toBe("🎮 Active games (1)");
  });

  test("in private without games says so", async () => {
    await sendText("/active", { userId: USER });
    expect(lastText()).toBe("You don't have any active games.");
  });

  test("lookup failures go through the command error handler", async () => {
    manager.getUserActiveGames!.mockImplementation(async () => {
      throw new Error("db offline");
    });

    await sendText("/active", { userId: USER });

    expect(errorSpy).toHaveBeenCalledWith("Error in active command:", expect.any(Error));
  });

  test("anonymous senders are ignored", async () => {
    await sendAnonymous("/active");
    expect(manager.getChatActiveGames).not.toHaveBeenCalled();
  });
});

describe("/public", () => {
  test("rejects invalid filters with usage", async () => {
    await sendText("/public coinflip giveaway", { userId: USER });
    expect(lastText()).toContain("Usage: <code>/public [coinflip|giveaway] [TICKER]</code>");
    expect(manager.getActivePublicGamesPage).not.toHaveBeenCalled();
  });

  test("reports when nothing is open, mentioning the filter", async () => {
    await sendText("/public", { userId: USER });
    expect(lastText()).toBe("No active public games found.");

    await sendText("/public ga $timba", { userId: USER });
    expect(lastText()).toBe("No active public games match Giveaway • TIMBA.");
    expect(manager.getActivePublicGamesPage!.mock.calls.at(-1)?.[1]).toMatchObject({
      page: 0,
      pageSize: 5,
      filter: { gameType: "giveaway", ticker: "TIMBA" },
    });
  });

  test("a non-empty total with an empty page is still treated as empty", async () => {
    manager.getActivePublicGamesPage!.mockImplementation(async () => ({
      games: [],
      totalGames: 3,
      page: 0,
    }));

    await sendText("/public", { userId: USER });

    expect(lastText()).toBe("No active public games found.");
  });

  test("lists games with filter-aware page buttons", async () => {
    manager.getActivePublicGamesPage!.mockImplementation(async () => ({
      games: listings(5),
      totalGames: 7,
      page: 0,
    }));

    await sendText("/public cf", { userId: USER });

    expect(lastText()).toBe("🌐 Active Public Games (7) • Coinflip • Page 1/2");
    expect(buttons(lastMessage()).map((button) => button.data)).toContain(
      "public_page:1:coinflip:*",
    );
  });

  test("lookup failures go through the command error handler", async () => {
    manager.getActivePublicGamesPage!.mockImplementation(async () => {
      throw new Error("db offline");
    });

    await sendText("/public", { userId: USER });

    expect(errorSpy).toHaveBeenCalledWith("Error in public command:", expect.any(Error));
  });

  test("anonymous senders are ignored", async () => {
    await sendAnonymous("/public");
    expect(manager.getActivePublicGamesPage).not.toHaveBeenCalled();
  });
});

describe("/games", () => {
  test("shows the full history on the 'all' tab using the username", async () => {
    manager.getUserGamesHistory!.mockImplementation(async () => history(1, 1, 1));

    await sendText("/games", { userId: USER, username: "neo" });

    expect(lastText()).toBe("@neo:all:0");
    expect(manager.buildGamesKeyboard!.mock.calls[0]?.[0]).toBe(String(USER));
    expect(lastCall("sendMessage")!.payload.link_preview_options).toEqual({ is_disabled: true });
  });

  test("falls back to the first name when there is no username", async () => {
    manager.getUserGamesHistory!.mockImplementation(async () => history(0, 1));

    await sendText("/games", { userId: USER });

    expect(lastText()).toBe("Tester:all:0");
  });

  test("an empty history says so", async () => {
    await sendText("/games", { userId: USER });
    expect(lastText()).toBe("You don't have any recent games.");
  });

  test("history failures go through the command error handler", async () => {
    manager.getUserGamesHistory!.mockImplementation(async () => {
      throw new Error("db offline");
    });

    await sendText("/games", { userId: USER });

    expect(errorSpy).toHaveBeenCalledWith("Error in games command:", expect.any(Error));
  });

  test("anonymous senders are ignored", async () => {
    await sendAnonymous("/games");
    expect(manager.getUserGamesHistory).not.toHaveBeenCalled();
  });
});

describe("games list callbacks", () => {
  test("switching tabs re-renders the owner's list", async () => {
    await press(`games_tab:won:1:${USER}`, { userId: USER });

    expect(lastText()).toBe("Tester:won:1");
    expect(lastCall("editMessageText")!.payload.link_preview_options).toEqual({
      is_disabled: true,
    });
  });

  test("other users cannot page someone else's list", async () => {
    await press(`games_tab:won:0:${USER}`, { userId: USER + 1 });

    expect(answers().at(-1)).toBe("This isn't your games list.");
    expect(callsTo("editMessageText")).toHaveLength(0);
  });

  test("re-selecting the current tab is not an error", async () => {
    failApiMethod("editMessageText", "Bad Request: message is not modified");

    await press(`games_tab:all:0:${USER}`, { userId: USER });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("other edit failures are handled as callback errors", async () => {
    failApiMethod("editMessageText", "Bad Request: message to edit not found");

    await press(`games_tab:all:0:${USER}`, { userId: USER });

    expect(
      errorSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("games tab")),
    ).toBe(true);
  });

  test("the tab handler rejects malformed data", async () => {
    const answer = mock(async () => true);
    await botModule.__test_handleGamesTabCallback({
      callbackQuery: { id: "cb", data: "games_tab:bogus" },
      api: { answerCallbackQuery: answer },
    } as any);
    expect(JSON.stringify(answer.mock.calls[0])).toContain("Invalid request.");
  });

  test("refreshing reloads the first page of the 'all' tab", async () => {
    await press(`games_refresh:${USER}`, { userId: USER });

    expect(lastText()).toBe("Tester:all:0");
    expect(answers().at(-1)).toBe("Refreshed!");
  });

  test("refreshing someone else's list is refused", async () => {
    await press(`games_refresh:${USER}`, { userId: USER + 1 });
    expect(answers().at(-1)).toBe("This isn't your games list.");
  });

  test("refreshing an unchanged list still confirms", async () => {
    failApiMethod("editMessageText", "Bad Request: message is not modified");

    await press(`games_refresh:${USER}`, { userId: USER });

    expect(answers().at(-1)).toBe("Refreshed!");
  });

  test("refresh edit failures are handled as callback errors", async () => {
    failApiMethod("editMessageText", "Bad Request: message to edit not found");

    await press(`games_refresh:${USER}`, { userId: USER });

    expect(
      errorSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("games refresh")),
    ).toBe(true);
  });
});

describe("active and public page callbacks", () => {
  test("the list header explains how to join", async () => {
    await press(botModule.__test_ACTIVE_LIST_HEADER_CALLBACK_DATA, { userId: USER });
    expect(answers().at(-1)).toBe("Select a join button below to enter a game.");
  });

  test("active pages show the requested slice for groups and private chats", async () => {
    manager.getChatActiveGames!.mockImplementation(async () => listings(7));
    await press("active_page:1", { userId: USER, chatId: GROUP });
    expect(lastText()).toBe("🎮 <b>Active games (7)</b> • Page 2/2");
    expect(answers().at(-1)).toBe("Page 2");

    manager.getUserActiveGames!.mockImplementation(async () => [
      { ...listing(1), keyboard: undefined },
    ]);
    await press("active_page:0", { userId: USER });
    expect(lastText()).toBe("🎮 <b>Active games (1)</b>");
  });

  test("active pages outside the range are refused", async () => {
    manager.getUserActiveGames!.mockImplementation(async () => listings(2));

    await press("active_page:3", { userId: USER });

    expect(answers().at(-1)).toBe("Invalid page.");
  });

  test("active page failures are handled as callback errors", async () => {
    manager.getUserActiveGames!.mockImplementation(async () => {
      throw new Error("db offline");
    });

    await press("active_page:0", { userId: USER });

    expect(
      errorSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("active page navigation"),
      ),
    ).toBe(true);
  });

  test("the active page handler validates its input", async () => {
    const answer = mock(async () => true);
    await botModule.__test_handleActivePageCallback({
      callbackQuery: { id: "cb1", data: "active_page:x" },
      api: { answerCallbackQuery: answer },
    } as any);
    await botModule.__test_handleActivePageCallback({
      callbackQuery: { id: "cb2", data: "active_page:0" },
      api: { answerCallbackQuery: answer },
    } as any);

    expect(JSON.stringify(answer.mock.calls[0])).toContain("Invalid page request.");
    expect(JSON.stringify(answer.mock.calls[1])).toContain(
      "Unable to determine the active-game scope.",
    );
  });

  test("public pages keep their filter and show the page", async () => {
    manager.getActivePublicGamesPage!.mockImplementation(async () => ({
      games: listings(2),
      totalGames: 7,
      page: 1,
    }));

    await press("public_page:1:*:TIMBA", { userId: USER });

    expect(manager.getActivePublicGamesPage!.mock.calls[0]?.[1]).toMatchObject({
      page: 1,
      filter: { ticker: "TIMBA" },
    });
    expect(answers().at(-1)).toBe("Page 2");
    expect(lastText()).toBe("🌐 <b>Active Public Games (7)</b> • TIMBA • Page 2/2");
  });

  test("an emptied public list says so, with or without a filter", async () => {
    await press("public_page:0", { userId: USER });
    expect(lastText()).toBe("No active public games found.");

    await press("public_page:0:coinflip:*", { userId: USER });
    expect(lastText()).toBe("No active public games match Coinflip.");
  });

  test("an unchanged public page is not an error", async () => {
    manager.getActivePublicGamesPage!.mockImplementation(async () => ({
      games: listings(1),
      totalGames: 1,
      page: 0,
    }));
    failApiMethod("editMessageText", "Bad Request: message is not modified");

    await press("public_page:0", { userId: USER });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("public page failures are handled as callback errors", async () => {
    manager.getActivePublicGamesPage!.mockImplementation(async () => {
      throw new Error("db offline");
    });

    await press("public_page:0", { userId: USER });

    expect(
      errorSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("public page navigation"),
      ),
    ).toBe(true);
  });

  test("the public page handler rejects malformed data", async () => {
    const answer = mock(async () => true);
    await botModule.__test_handlePublicPageCallback({
      callbackQuery: { id: "cb", data: "public_page:x" },
      api: { answerCallbackQuery: answer },
    } as any);
    expect(JSON.stringify(answer.mock.calls[0])).toContain("Invalid page request.");
  });
});
