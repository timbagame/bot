import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  answers,
  bot,
  botModule,
  buttons,
  callsTo,
  failApiMethod,
  lastMessage,
  messageCalls,
  messageIdOf,
  messageText,
  press,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import { OracleClient } from "../src/utils/oracle";
import { clearAllGameSetupSessions, getGameSetupSession } from "../src/utils/user-state";
import * as prices from "../src/utils/prices";
import { PublicKey } from "@solana/web3.js";
import { encodeGameConfirmPayload } from "../src/utils/callback-data";

useBotHarness();

const CHAT = -1_007_700;
let CREATOR = 77_000;
const OTHER = 99_000;

type CreateCall = {
  gameType: string;
  data: any;
  maxPlayers: number;
  minPlayers: number;
  timeout: number;
  options: any;
};
let createCalls: CreateCall[];
let createResult: any;
let gameMessages: unknown[][];
let originalGameManager: typeof botModule.gameManager;

beforeEach(() => {
  originalGameManager = botModule.gameManager;
  CREATOR += 1;
  resetCalls();
  clearAllGameSetupSessions();
  createCalls = [];
  gameMessages = [];
  createResult = { success: true, gameAddress: "GAME_ADDRESS_1" };
  stub(wallet, "getTokenBalance", async () => 500_000_000);
  stub(wallet, "getBalance", async () => 5_000_000_000);
  stub(OracleClient.getInstance(), "requireTokenPolicy", (async (mint: string) => ({
    mint,
    minimumAmountRaw: "1000000",
    acceptedMinimumAmountRaw: "1000000",
    revision: 1,
    enabled: true,
  })) as any);
  // Contracts before 0.3.0 read the minimum stake from the on-chain game token account.
  botModule.__test_setProgram({
    programId: new PublicKey("11111111111111111111111111111112"),
    account: { gameToken: { fetch: async () => ({ minAmount: 1_000_000 }) } },
  } as any);
  botModule.__test_setGameManager({
    hasGameCreationRequest: () => false,
    createGame: async (
      gameType: string,
      data: any,
      maxPlayers: number,
      minPlayers: number,
      timeout: number,
      _creator: bigint,
      options: any,
    ) => {
      createCalls.push({ gameType, data, maxPlayers, minPlayers, timeout, options });
      return typeof createResult === "function" ? createResult() : createResult;
    },
    createGameMessage: async (...args: unknown[]) => {
      gameMessages.push(args);
      return 4242;
    },
    clearPendingGameCreation: () => {},
    updateGameMessageFromData: async () => {},
    recoverPendingGameCreationByAddress: async () => {},
  } as any);
});

afterEach(() => {
  restoreStubs();
  botModule.__test_setGameManager(originalGameManager);
  botModule.__test_resetProgram();
  clearAllGameSetupSessions();
});

const group = (userId = CREATOR) => ({ userId, chatId: CHAT });

/** Run /cf or /ga without arguments and return the setup message id. */
const openSetup = async (command = "/cf") => {
  await sendText(command, group());
  const setup = lastMessage()!;
  expect(messageText(setup)).toContain(command === "/cf" ? "Create Coinflip" : "Create Giveaway");
  return messageIdOf(setup);
};

const clickLabel = async (label: string, messageId: number, userId = CREATOR) => {
  const button = buttons(
    messageCalls()
      .filter((call) => buttons(call).some((b) => b.text === label))
      .at(-1),
  ).find((b) => b.text === label);
  if (!button) throw new Error(`No button labelled ${label}`);
  await press(button.data, { ...group(userId), messageId });
  return button.data;
};

/** Click the button whose callback data starts with `prefix` and whose label is `label`. */
const clickControl = async (prefix: string, label: string, messageId: number) => {
  const button = buttons(lastMessage()).find((b) => b.data.startsWith(prefix) && b.text === label);
  if (!button) throw new Error(`No ${prefix} button labelled ${label}`);
  await press(button.data, { ...group(), messageId });
};

const replyTo = (messageId: number, text: string, userId = CREATOR) =>
  sendText(text, { ...group(userId), replyTo: messageId });

describe("interactive game setup", () => {
  test("amount, players and advanced options lead to a created game", async () => {
    const setupId = await openSetup();
    await clickLabel("5", setupId);
    expect(messageText(lastMessage())).toContain("Choose Maximum Players");
    expect(messageText(lastMessage())).toContain("Amount: <b>5");

    await clickLabel("👥 2", setupId);
    expect(messageText(lastMessage())).toContain("Confirm Coinflip");

    await clickLabel("+50%", setupId);
    expect(messageText(lastMessage())).toContain("Timeout: <b>1h 30m</b>");
    await clickLabel("12h", setupId);
    expect(messageText(lastMessage())).toContain("Timeout: <b>12h</b>");

    await clickLabel("🌐 Public", setupId);
    expect(messageText(lastMessage())).toContain("Visibility: <b>Private</b>");

    const session = getGameSetupSession(`${CHAT}_${setupId}`);
    expect(session).toMatchObject({ players: 2, timeoutSeconds: 12 * 3600, isPrivate: true });

    await clickLabel("✅ Create Game", setupId);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      gameType: "coinflip",
      maxPlayers: 2,
      minPlayers: 2,
      timeout: 12 * 3600,
      options: { isPrivate: true },
    });
    expect(createCalls[0]!.data.amount).toBe(5_000_000);
    expect(callsTo("deleteMessage").at(-1)!.payload.message_id).toBe(setupId);
    expect(gameMessages).toHaveLength(1);
    expect(getGameSetupSession(`${CHAT}_${setupId}`)).toBeUndefined();
  });

  test("giveaways let the creator raise the minimum players", async () => {
    const setupId = await openSetup("/ga");
    await clickLabel("5", setupId);
    await clickLabel("👥 10", setupId);
    expect(messageText(lastMessage())).toContain("Min players to start: <b>1/10</b>");
    await clickControl("cm|", "+50%", setupId);
    expect(messageText(lastMessage())).not.toContain("Min players to start: <b>1/10</b>");
    await clickControl("cm|", "MAX", setupId);
    expect(messageText(lastMessage())).toContain("Min players to start: <b>10/10</b>");
    await clickLabel("✅ Create Game", setupId);
    expect(createCalls[0]).toMatchObject({ gameType: "giveaway", maxPlayers: 10, minPlayers: 10 });
  });

  test("only the creator can change or confirm the setup", async () => {
    const setupId = await openSetup();
    await clickLabel("5", setupId, OTHER);
    expect(answers().at(-1)).toBe("🚫 Only the game creator can modify this game setup!");
    await clickLabel("5", setupId);
    await clickLabel("👥 2", setupId);
    await clickLabel("✅ Create Game", setupId, OTHER);
    expect(answers().at(-1)).toBe("❌ Only the game creator can confirm this setup!");
    expect(createCalls).toHaveLength(0);
  });

  test("retired confirmation buttons explain how to restart without changing active setup", async () => {
    const setupId = await openSetup();
    const activeSession = getGameSetupSession(`${CHAT}_${setupId}`);
    if (!activeSession) throw new Error("Expected an active setup session");
    const session = { ...activeSession };
    for (const prefix of ["game", "timeout", "visibility", "min_players"]) {
      resetCalls();
      await press(`confirm_${prefix}_coinflip_2_2_${CREATOR}`, {
        ...group(),
        messageId: setupId,
      });
      expect(answers()).toEqual([
        "This setup uses retired buttons. Start a new game with /coinflip or /giveaway.",
      ]);
      expect(createCalls).toHaveLength(0);
      expect(messageCalls()).toHaveLength(0);
      expect(getGameSetupSession(`${CHAT}_${setupId}`)).toEqual(session);
    }
  });

  test("legacy amount and player callbacks still work", async () => {
    const setupId = await openSetup();
    await press(`amount_coinflip_2_${CREATOR}`, { ...group(), messageId: setupId });
    expect(messageText(lastMessage())).toContain("Amount: <b>2");
    await press(`players_coinflip_2_3_${CREATOR}`, { ...group(), messageId: setupId });
    expect(messageText(lastMessage())).toContain("Players: <b>3</b>");
  });

  test("custom amounts are validated before choosing players", async () => {
    const setupId = await openSetup();
    await clickLabel("✏️ Custom Amount", setupId);
    expect(getGameSetupSession(`${CHAT}_${setupId}`)?.waitingFor).toBe("amount_input");

    await replyTo(setupId, "abc");
    expect(messageText(lastMessage())).toContain("Invalid amount");
    await replyTo(setupId, "1000000");
    expect(messageText(lastMessage())).toBe("❌ Amount too high. Please try a lower amount.");
    await replyTo(setupId, "0.5");
    expect(messageText(lastMessage())).toContain("Amount below current minimum of 1");

    await replyTo(setupId, "3.25");
    expect(messageText(lastMessage())).toContain("Choose Maximum Players");
    expect(getGameSetupSession(`${CHAT}_${setupId}`)).toMatchObject({
      waitingFor: "setup",
      amount: "3.25",
    });
  });

  test("custom player counts are range checked", async () => {
    const setupId = await openSetup();
    await clickLabel("5", setupId);
    await clickLabel("📊 Custom Players", setupId);
    expect(getGameSetupSession(`${CHAT}_${setupId}`)?.waitingFor).toBe("players_input");

    await replyTo(setupId, "1");
    expect(messageText(lastMessage())).toContain("Invalid number of players");
    await replyTo(setupId, "7");
    expect(messageText(lastMessage())).toContain("Players: <b>7</b>");
  });

  test("input from another user is refused", async () => {
    const setupId = await openSetup();
    await clickLabel("✏️ Custom Amount", setupId);
    await replyTo(setupId, "3", OTHER);
    expect(messageText(lastMessage())).toBe("Only the game creator can update this setup");
  });

  test("setups can be cancelled and navigated back", async () => {
    const setupId = await openSetup();
    await clickLabel("5", setupId);
    await press(`back_to_amounts_coinflip_${CREATOR}`, { ...group(), messageId: setupId });
    expect(messageText(lastMessage())).toContain("Select Amount - Coinflip");
    await press(`type_amount_coinflip_${CREATOR}`, { ...group(), messageId: setupId });
    expect(getGameSetupSession(`${CHAT}_${setupId}`)?.waitingFor).toBe("amount_input");
    await clickLabel("❌ Cancel", setupId);
    expect(getGameSetupSession(`${CHAT}_${setupId}`)).toBeUndefined();
    await press(`cancel_game_setup_${CREATOR}`, { ...group(OTHER), messageId: setupId });
    expect(answers().at(-1)).toBe("❌ Only the game creator can cancel this setup!");
  });

  test("noop buttons only acknowledge", async () => {
    await press("noop", group());
    expect(answers()).toEqual([undefined]);
  });
});

describe("game creation outcomes", () => {
  const reachConfirm = async () => {
    const setupId = await openSetup();
    await clickLabel("5", setupId);
    await clickLabel("👥 2", setupId);
    return setupId;
  };

  test("balance errors restore the confirm card with a clear notice", async () => {
    createResult = { success: false, error: "Insufficient funds: your balance is too low" };
    const setupId = await reachConfirm();
    await clickLabel("✅ Create Game", setupId);
    const texts = messageCalls().map(messageText);
    expect(texts.some((text) => text.includes("insufficient funds"))).toBe(true);
    // The restored card keeps a retry button with the same confirmation payload.
    expect(buttons(lastMessage()).some((b) => b.data.startsWith("cg|"))).toBe(true);
  });

  test("rate limits and active game limits get specific notices", async () => {
    for (const [error, notice] of [
      ["game creation rate limit reached", "Too many games are being created"],
      ["active game limit reached", "too many active games"],
      ["boom", "Failed to create game. Please try again."],
    ]) {
      resetCalls();
      createResult = { success: false, error };
      const setupId = await reachConfirm();
      await clickLabel("✅ Create Game", setupId);
      expect(
        messageCalls()
          .map(messageText)
          .some((text) => text.includes(notice!)),
      ).toBe(true);
    }
  });

  test("a confirmed transaction without delivery is recovered in the background", async () => {
    const recovered: string[] = [];
    botModule.__test_setGameManager({
      createGame: async () => ({
        success: false,
        confirmedSignature: "sig",
        gameAddress: "CONFIRMED_GAME",
      }),
      recoverPendingGameCreationByAddress: async (_ctx: unknown, address: string) => {
        recovered.push(address);
      },
    } as any);
    const setupId = await reachConfirm();
    await clickLabel("✅ Create Game", setupId);
    expect(recovered).toEqual(["CONFIRMED_GAME"]);
    expect(callsTo("deleteMessage").at(-1)!.payload.message_id).toBe(setupId);
  });

  test("a missing game address is reported", async () => {
    createResult = { success: true };
    const setupId = await reachConfirm();
    await clickLabel("✅ Create Game", setupId);
    expect(messageText(lastMessage())).toContain("Game created but address not returned");
  });

  test("auto-join outcomes refresh or warn", async () => {
    createResult = { success: true, gameAddress: "G1", autoJoinResult: { success: false } };
    const setupId = await reachConfirm();
    await clickLabel("✅ Create Game", setupId);
    expect(messageText(lastMessage())).toContain("Failed to auto-join game");
  });

  test("a vanished confirm message still creates the game", async () => {
    const setupId = await reachConfirm();
    failApiMethod("editMessageReplyMarkup", "Bad Request: message to edit not found");
    await clickLabel("✅ Create Game", setupId);
    expect(createCalls).toHaveLength(1);
    expect(callsTo("deleteMessage")).toHaveLength(0);
  });

  test("unexpected errors restore the confirm card", async () => {
    createResult = () => {
      throw new Error("rpc down");
    };
    const setupId = await reachConfirm();
    await clickLabel("✅ Create Game", setupId);
    expect(answers()).toContain("❌ Error creating game");
    expect(
      messageCalls()
        .map(messageText)
        .some((text) => text.includes("interrupted")),
    ).toBe(true);
  });

  test("duplicate confirmations for the same request are ignored", async () => {
    const setupId = await reachConfirm();
    botModule.__test_setGameManager({
      hasGameCreationRequest: () => true,
      createGame: async () => {
        throw new Error("should not run");
      },
    } as any);
    await clickLabel("✅ Create Game", setupId);
    expect(answers().at(-1)).toBeUndefined();
  });
});

describe("game creation edge cases", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const reachConfirm = async () => {
    const setupId = await openSetup();
    await clickLabel("5", setupId);
    await clickLabel("👥 2", setupId);
    return setupId;
  };
  const confirmData = (amount: string) =>
    encodeGameConfirmPayload({
      gameType: "coinflip",
      amount,
      players: 2,
      timeoutSeconds: 3600,
      minPlayers: 2,
      isPrivate: false,
      creatorId: String(CREATOR),
    })!;
  const warned = (text: string) =>
    warnSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));
  const errored = (text: string) =>
    errorSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

  test("amounts too large for a safe raw integer are refused before anything changes", async () => {
    const setupId = await openSetup();

    await press(confirmData("100000000000"), { ...group(), messageId: setupId });

    expect(answers().at(-1)).toBe("Amount is too large; please enter a smaller value.");
    expect(createCalls).toEqual([]);
  });

  test("a confirmed game is recovered even when recovery and cleanup fail", async () => {
    const recovered: string[] = [];
    botModule.__test_setGameManager({
      createGame: async () => ({
        success: false,
        confirmedSignature: "sig",
        gameAddress: "CONFIRMED_GAME",
      }),
      recoverPendingGameCreationByAddress: async (_ctx: unknown, address: string) => {
        recovered.push(address);
        throw new Error("rpc down");
      },
    } as any);
    const setupId = await reachConfirm();
    failApiMethod("deleteMessage", "Bad Request: message can't be deleted");

    await clickLabel("✅ Create Game", setupId);

    expect(recovered).toEqual(["CONFIRMED_GAME"]);
    expect(warned("Confirmed game delivery will be retried in the background")).toBe(true);
    expect(warned("Could not delete failed game confirmation")).toBe(true);
  });

  test("a confirmation that cannot be deleted is marked as created instead", async () => {
    const setupId = await reachConfirm();
    failApiMethod("deleteMessage", "Bad Request: message can't be deleted");

    await clickLabel("✅ Create Game", setupId);

    expect(createCalls).toHaveLength(1);
    expect(messageCalls().map(messageText)).toContain(
      "✅ Game created!\n\n<code>GAME_ADDRESS_1</code>",
    );
    expect(gameMessages).toHaveLength(1);
  });

  test("marking the confirmation fails quietly when editing is also refused", async () => {
    const setupId = await reachConfirm();
    failApiMethod("deleteMessage", "Bad Request: message can't be deleted");
    failApiMethod("editMessageText", "Bad Request: message can't be edited");

    await clickLabel("✅ Create Game", setupId);

    expect(gameMessages).toHaveLength(1);
    expect(warned("Failed to mark confirmation message as processed")).toBe(true);
  });

  test("a failed card refresh after auto-join is only logged", async () => {
    createResult = { success: true, gameAddress: "G2", autoJoinResult: { success: true } };
    botModule.__test_setGameManager({
      createGame: async () => createResult,
      createGameMessage: async () => 4242,
      clearPendingGameCreation: () => {},
      updateGameMessageFromData: async () => {
        throw new Error("telegram down");
      },
    } as any);
    const setupId = await reachConfirm();

    await clickLabel("✅ Create Game", setupId);

    expect(errored("Failed to update game message after auto-join")).toBe(true);
    expect(answers().at(-1)).toBeUndefined();
  });

  test("a delivery failure after creation hands the game to recovery", async () => {
    const recovered: string[] = [];
    botModule.__test_setGameManager({
      createGame: async () => ({ success: true, gameAddress: "G3" }),
      createGameMessage: async () => {
        throw new Error("chat not found");
      },
      recoverPendingGameCreationByAddress: async (_ctx: unknown, address: string) => {
        recovered.push(address);
        throw new Error("still down");
      },
    } as any);
    const setupId = await reachConfirm();

    await clickLabel("✅ Create Game", setupId);

    expect(recovered).toEqual(["G3"]);
    expect(answers()).not.toContain("❌ Error creating game");
  });

  test("an interrupted creation with no card to restore reports failure, even if that fails", async () => {
    createResult = () => {
      throw new Error("rpc down");
    };
    const setupId = await reachConfirm();
    failApiMethod("editMessageReplyMarkup", "Bad Request: message to edit not found");
    failApiMethod("sendMessage", "Forbidden: bot was kicked", 403);

    await clickLabel("✅ Create Game", setupId);

    expect(answers()).toContain("❌ Error creating game");
    expect(errored("Failed to update confirmation message after error")).toBe(true);
  });

  test("creation works for confirmations without a message date", async () => {
    const setupId = await reachConfirm();
    await bot.handleUpdate({
      update_id: 88_000_001,
      callback_query: {
        id: "no-date",
        from: { id: CREATOR, is_bot: false, first_name: "Tester" },
        chat_instance: "instance",
        data: confirmData("5"),
        message: {
          message_id: setupId,
          chat: { id: CHAT, type: "supergroup", title: "Test Group" },
          text: "confirm",
        },
      },
    });

    expect(createCalls).toHaveLength(1);
  });
});

describe("setup prompt failures", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());
  const failMenus = () => {
    failApiMethod("editMessageText", "Bad Request: message can't be edited");
    failApiMethod("sendMessage", "Forbidden: bot was kicked", 403);
  };

  test("a custom amount prompt reads the balance when the session has none", async () => {
    const setupId = await openSetup();
    const { upsertGameSetupSession } = await import("../src/utils/user-state");
    upsertGameSetupSession(`${CHAT}_${setupId}`, { userBalance: 0 });
    stub(wallet, "getTokenBalance", async () => {
      throw new Error("rpc down");
    });

    await press(`custom_amount_coinflip_${CREATOR}`, { ...group(), messageId: setupId });

    expect(answers().at(-1)).toBe("Type your amount...");
    expect(getGameSetupSession(`${CHAT}_${setupId}`)).toMatchObject({
      waitingFor: "amount_input",
      userBalance: 0,
    });
  });

  test("going back to amounts reads the balance when the session has none", async () => {
    const setupId = await openSetup();
    const { upsertGameSetupSession } = await import("../src/utils/user-state");
    upsertGameSetupSession(`${CHAT}_${setupId}`, { userBalance: 0 });
    stub(wallet, "getTokenBalance", async () => {
      throw new Error("rpc down");
    });

    await press(`back_to_amounts_coinflip_${CREATOR}`, { ...group(), messageId: setupId });

    expect(messageText(lastMessage())).toContain("Select Amount - Coinflip");
  });

  test.each([
    [
      "custom_amount",
      (id: number) => `custom_amount_coinflip_${id}`,
      "❌ Error setting up text input",
    ],
    ["cancel", (id: number) => `cancel_game_setup_${id}`, "❌ Error cancelling"],
  ])("a %s menu that cannot be shown is answered with an error", async (_label, data, answer) => {
    const setupId = await openSetup();
    failMenus();

    await press(data(CREATOR), { ...group(), messageId: setupId });

    expect(answers().at(-1)).toBe(answer);
  });

  test("a custom players prompt that cannot be shown is answered with an error", async () => {
    const setupId = await openSetup();
    await press(`amount_coinflip_2_${CREATOR}`, { ...group(), messageId: setupId });
    failMenus();

    await press(`custom_players_coinflip_2_${CREATOR}`, { ...group(), messageId: setupId });

    expect(answers().at(-1)).toBe("❌ Error setting up players input");
  });

  test("non-text messages skip the typed setup handler", async () => {
    const setupId = await openSetup();
    await clickLabel("✏️ Custom Amount", setupId);
    const before = messageCalls().length;

    await bot.handleUpdate({
      update_id: 88_000_002,
      message: {
        message_id: 99_001,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT, type: "supergroup", title: "Test Group" },
        from: { id: CREATOR, is_bot: false, first_name: "Tester" },
        sticker: {
          file_id: "sticker",
          file_unique_id: "sticker",
          type: "regular",
          width: 1,
          height: 1,
          is_animated: false,
          is_video: false,
        },
        reply_to_message: {
          message_id: setupId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: CHAT, type: "supergroup", title: "Test Group" },
          text: "prompt",
        },
      },
    } as any);

    expect(getGameSetupSession(`${CHAT}_${setupId}`)?.waitingFor).toBe("amount_input");
    expect(messageCalls().length).toBe(before);
  });
});

// Runs last: a resolved price is cached by the bot and changes the suggested amounts.
describe("USD amounts", () => {
  test("USD amounts need a token price", async () => {
    const setupId = await openSetup();
    await clickLabel("✏️ Custom Amount", setupId);
    await replyTo(setupId, "$0");
    expect(messageText(lastMessage())).toContain("Invalid USD amount");

    // No price source answers in tests, so USD input is refused.
    await replyTo(setupId, "$10");
    expect(messageText(lastMessage())).toContain("USD pricing unavailable");

    const tokenMint = getGameSetupSession(`${CHAT}_${setupId}`)!.tokenMint!;
    prices.__test_resetPriceCache();
    stub(
      globalThis,
      "fetch",
      (async () =>
        new Response(JSON.stringify({ data: { [tokenMint]: { usdPrice: 2 } } }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    await replyTo(setupId, "10 USD");
    expect(messageText(lastMessage())).toContain("Amount: <b>5");
    expect(getGameSetupSession(`${CHAT}_${setupId}`)?.amount).toBe("5");
    prices.__test_resetPriceCache();
  });
});

describe("game card buttons", () => {
  const saveCompletedGame = (address: string, winner: string) => {
    const db = botModule.__test_getGameDatabase();
    db.saveGame(address, String(CREATOR), 1_000_000, "coinflip", "SOL", "SOL", 2, 2, CHAT);
    db.completeGame(address, winner);
  };

  test("unknown games are reported as expired", async () => {
    botModule.__test_setGameManager({ ensureGameDataFromChain: async () => null } as any);
    await press("join_UnknownGame111", group());
    expect(answers().at(-1)).toBe("Game not found or has expired.");
  });

  test("buttons on finished games refresh the card", async () => {
    const updates: unknown[][] = [];
    botModule.__test_setGameManager({
      updateGameMessageFromData: async (...args: unknown[]) => {
        updates.push(args.slice(1));
      },
    } as any);
    saveCompletedGame("DoneGame1", "WINNER_KEY");
    await press("join_DoneGame1", group());
    expect(updates).toEqual([["DoneGame1", "Completed", "WINNER_KEY"]]);
    expect(answers().at(-1)).toBe("Game completed - message updated!");

    saveCompletedGame("DoneGame2", "cancelled");
    await press("refresh_DoneGame2", group());
    expect(answers().at(-1)).toBe("Game cancelled - message updated!");
  });

  test("failures while refreshing a finished game are acknowledged", async () => {
    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {
        throw new Error("telegram down");
      },
    } as any);
    saveCompletedGame("DoneGame3", "WINNER_KEY");
    await press("join_DoneGame3", group());
    expect(answers().at(-1)).toBe("Failed to update game message");
  });

  test("the legacy custom players button asks for a player count", async () => {
    const setupId = await openSetup();
    await press(`amount_coinflip_2_${CREATOR}`, { ...group(), messageId: setupId });
    await press(`custom_players_coinflip_2_${CREATOR}`, { ...group(), messageId: setupId });
    expect(getGameSetupSession(`${CHAT}_${setupId}`)?.waitingFor).toBe("players_input");
    await replyTo(setupId, "4");
    expect(messageText(lastMessage())).toContain("Players: <b>4</b>");
  });
});
