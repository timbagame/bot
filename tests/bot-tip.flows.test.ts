import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import {
  bot,
  botModule,
  callsTo,
  failApiMethod,
  clearApiOverride,
  lastText,
  overrideApiMethod,
  resetCalls,
  restoreStubs,
  stub,
  texts,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import * as priceService from "../src/utils/price-service";
import { WSOL_MINT } from "../src/utils/constants";

useBotHarness();

const CHAT = -4_200;
const SENDER = 71_001;
const TARGET = 71_002;
const LAMPORTS = 1_000_000_000;
const USAGE = "Usage:";
let updateId = 93_000_000;

let parseResult: any;
let parseCalls: any[][];
let lookups: Record<string, string | undefined>;
let primed: Array<[string, string]>;
let loosePrimed: Array<[string, string]>;
let savedTokenManager: any;
let savedGameManager: any;
let priceSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let transferSol: ReturnType<typeof mock>;
let transferToken: ReturnType<typeof mock>;
let recipientKey: string;

const solAmount = {
  amount: 2 * LAMPORTS,
  isSol: true,
  formattedAmount: "2 SOL",
  tokenMint: WSOL_MINT,
  tokenTicker: "SOL",
  decimals: 9,
  tokenWasSpecified: true,
};

beforeEach(async () => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  parseResult = { success: true, data: solAmount };
  parseCalls = [];
  lookups = {};
  primed = [];
  loosePrimed = [];
  savedTokenManager = botModule.__test_getTokenManager();
  savedGameManager = botModule.__test_getGameManager();
  botModule.__test_setTokenManager({
    parseAmount: async (...args: any[]) => {
      parseCalls.push(args);
      return parseResult;
    },
  } as any);
  botModule.__test_setGameManager({
    findTelegramIdByUsername: (username: string) => lookups[username],
    primeUsernameCache: (_ctx: unknown, id: string, name: string, isHandle?: boolean) => {
      // Only handles Telegram reported may claim a name; the rest must not be saved.
      if (isHandle === true) primed.push([id, name]);
      else loosePrimed.push([id, name]);
    },
  } as any);
  priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue({ price: 150 } as any);
  recipientKey = (await Keypair.generate()).publicKey.toBase58();
  const keypair = await Keypair.generate();
  stub(wallet, "getKeyPair", async () => keypair);
  stub(wallet, "getPublicKey", async () => recipientKey);
  stub(wallet, "getBalance", async () => 10 * LAMPORTS);
  stub(wallet, "getTokenBalance", async () => 1_000_000);
  transferSol = mock(async () => "sol-sig");
  transferToken = mock(async () => "token-sig");
  stub(wallet, "transferSol", transferSol);
  stub(wallet, "transferToken", transferToken);
  overrideApiMethod("getChatMember", (payload) => ({
    status: "member",
    user: { id: payload.user_id, is_bot: false, first_name: "Member" },
  }));
});

afterEach(() => {
  botModule.__test_setTokenManager(savedTokenManager);
  botModule.__test_setGameManager(savedGameManager);
  clearApiOverride("getChatMember");
  restoreStubs();
  priceSpy.mockRestore();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

type TipOptions = {
  entities?: any[];
  replyFrom?: Record<string, unknown>;
  from?: Record<string, unknown> | null;
};

const tip = (text: string, options: TipOptions = {}) => {
  const chat = { id: CHAT, type: "supergroup", title: "Group" };
  const command = text.split(/\s+/)[0]!;
  return bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat,
      ...(options.from === null
        ? { sender_chat: { id: CHAT, type: "supergroup", title: "Group" } }
        : { from: options.from ?? { id: SENDER, is_bot: false, first_name: "Sender" } }),
      text,
      entities: [
        { type: "bot_command", offset: 0, length: command.length },
        ...(options.entities ?? []),
      ],
      ...(options.replyFrom
        ? {
            reply_to_message: {
              message_id: 5,
              date: 1,
              chat,
              from: options.replyFrom,
              text: "hi",
            },
          }
        : {}),
    },
  } as any);
};

const mentionEntity = (text: string, mention: string) => ({
  type: "mention",
  offset: text.indexOf(mention),
  length: mention.length,
});

describe("/tip argument validation", () => {
  test("anonymous senders get no tip processed", async () => {
    await tip("/tip @bob 1", { from: null });

    expect(parseCalls).toHaveLength(0);
    expect(transferSol).not.toHaveBeenCalled();
  });

  test("a bare /tip without a reply explains usage", async () => {
    await tip("/tip");
    expect(lastText()).toContain(USAGE);
  });

  test("replying to a bot is refused", async () => {
    await tip("/tip 1", { replyFrom: { id: 1, is_bot: true, first_name: "Bot" } });
    expect(lastText()).toBe("You cannot tip bots!");
  });

  test("replying to your own message is refused", async () => {
    await tip("/tip 1", { replyFrom: { id: SENDER, is_bot: false, first_name: "Me" } });
    expect(lastText()).toBe("You can't tip yourself!");
  });

  test("a mention with no amount explains usage", async () => {
    lookups["@bob"] = String(TARGET);
    const text = "/tip @bob";

    await tip(text, { entities: [mentionEntity(text, "@bob")] });

    expect(lastText()).toContain(USAGE);
    expect(parseCalls).toHaveLength(0);
  });

  test("args without any mention explain usage", async () => {
    await tip("/tip 5 SOL");
    expect(lastText()).toContain(USAGE);
  });

  test("unknown usernames ask the recipient to start the bot", async () => {
    const text = "/tip @ghost<x> 1";

    await tip(text, { entities: [mentionEntity(text, "@ghost<x>")] });

    expect(lastText()).toBe(
      "Unable to resolve <code>@ghost&lt;x&gt;</code>. Ask them to start a chat with the bot first.",
    );
  });

  test("a saved @display name cannot receive a tip, while a verified username can", async () => {
    const db = botModule.__test_getGameDatabase();
    const manager = botModule.__test_getGameManager();
    manager.findTelegramIdByUsername = db.findTelegramIdByUsername.bind(db);
    db.savePlayerMapping("fictional-tip-impersonator", "71003", "@tip_impersonated");
    const recipientIds: bigint[] = [];
    stub(wallet, "getPublicKey", async (id: bigint) => {
      recipientIds.push(id);
      return recipientKey;
    });

    await tip("/tip @tip_impersonated 2 SOL");

    expect(lastText()).toBe(
      "Unable to resolve <code>@tip_impersonated</code>. Ask them to start a chat with the bot first.",
    );
    expect(transferSol).not.toHaveBeenCalled();
    expect(transferToken).not.toHaveBeenCalled();
    expect(recipientIds).toEqual([]);
    expect(callsTo("getChatMember")).toHaveLength(0);

    db.saveUsernameMapping("tip_impersonated", String(TARGET), "@tip_impersonated");
    await tip("/tip @tip_impersonated 2 SOL");

    expect(recipientIds).toEqual([BigInt(TARGET)]);
    expect(transferSol).toHaveBeenCalledWith(BigInt(SENDER), recipientKey, 2 * LAMPORTS);
  });

  test("an unusable stored id is reported instead of crashing", async () => {
    lookups["@weird"] = "not-a-number";
    const text = "/tip @weird 1";

    await tip(text, { entities: [mentionEntity(text, "@weird")] });

    expect(lastText()).toBe(
      "Unable to resolve the specified user. Please try replying to their message instead.",
    );
  });

  test("mentioning yourself is refused", async () => {
    lookups["@me"] = String(SENDER);
    const text = "/tip @me 1";

    await tip(text, { entities: [mentionEntity(text, "@me")] });

    expect(lastText()).toBe("You can't tip yourself!");
  });

  test("a mention that Telegram reports as a bot is refused", async () => {
    lookups["@helper_bot"] = String(TARGET);
    overrideApiMethod("getChatMember", (payload) => ({
      status: "member",
      user: { id: payload.user_id, is_bot: true, first_name: "Helper" },
    }));
    const text = "/tip @helper_bot 1";

    await tip(text, { entities: [mentionEntity(text, "@helper_bot")] });

    expect(lastText()).toBe("You cannot tip bots!");
  });

  test("a text mention of a bot is refused without asking Telegram", async () => {
    const text = "/tip Robo 1";

    await tip(text, {
      entities: [
        {
          type: "text_mention",
          offset: 5,
          length: 4,
          user: { id: TARGET, is_bot: true, first_name: "Robo" },
        },
      ],
    });

    expect(lastText()).toBe("You cannot tip bots!");
    expect(callsTo("getChatMember")).toHaveLength(0);
  });

  test("amount parse errors are shown, with a friendly message for overflow", async () => {
    parseResult = { success: false, error: "amount_too_large" };
    await tip("/tip 99999999999", { replyFrom: { id: TARGET, is_bot: false, first_name: "T" } });
    expect(lastText()).toBe("Amount is too large; please use a smaller value.");

    parseResult = { success: false, error: "invalid_amount" };
    await tip("/tip lots", { replyFrom: { id: TARGET, is_bot: false, first_name: "T" } });
    expect(lastText()).toContain("Please provide a valid amount greater than 0.");
  });
});

describe("/tip recipients and amounts", () => {
  test("replying to a user with a username tips them with a USD value and notifies them", async () => {
    await tip("/tip 2", {
      replyFrom: { id: TARGET, is_bot: false, first_name: "Target", username: "target" },
    });

    expect(primed).toContainEqual([String(TARGET), "@target"]);
    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to @target…");
    expect(lastText()).toContain("sent you <b>2 SOL ($300)</b>");
    expect(String((transferSol.mock.calls[0] as any[])[1])).toBe(recipientKey);
    expect((transferSol.mock.calls[0] as any[])[2]).toBe(2 * LAMPORTS);
    const dm = callsTo("sendMessage").at(-1)!;
    expect(dm.payload.chat_id).toBe(TARGET);
    expect(priceSpy.mock.calls[0]?.[0]).toMatchObject({ tokenMint: WSOL_MINT });
  });

  test("replying to a user without a username uses their first name", async () => {
    await tip("/tip 2", { replyFrom: { id: TARGET, is_bot: false, first_name: "Tina" } });

    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to Tina…");
    expect(primed).toHaveLength(0);
  });

  test("replying to a user with no names falls back to 'User'", async () => {
    await tip("/tip 2", { replyFrom: { id: TARGET, is_bot: false } });
    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to User…");
  });

  test("token tips transfer the SPL token and value whole-unit tokens without decimals", async () => {
    parseResult = {
      success: true,
      data: {
        amount: 3,
        isSol: false,
        formattedAmount: "3 NFT",
        tokenMint: "NftMint",
        tokenTicker: "NFT",
        decimals: 0,
        tokenWasSpecified: true,
      },
    };
    priceSpy.mockResolvedValue({ price: 2 } as any);

    await tip("/tip 3 NFT", { replyFrom: { id: TARGET, is_bot: false, first_name: "T" } });

    expect(transferToken.mock.calls[0]?.slice(2)).toEqual([3, "NftMint"]);
    expect(texts()).toContain("⏳ Tip of 3 NFT ($6) to T…");
    expect(priceSpy.mock.calls[0]?.[0]).toMatchObject({ tokenMint: "NftMint" });
  });

  test("the USD suffix is omitted when the price is missing, non-positive or unavailable", async () => {
    const replyFrom = { id: TARGET, is_bot: false, first_name: "T" };

    priceSpy.mockResolvedValue(null as any);
    await tip("/tip 2", { replyFrom });
    priceSpy.mockResolvedValue({ price: -1 } as any);
    await tip("/tip 2", { replyFrom });
    priceSpy.mockRejectedValue(new Error("price api down"));
    await tip("/tip 2", { replyFrom });

    expect(texts().filter((text) => text === "⏳ Tip of 2 SOL to T…")).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledWith("Failed to fetch token price for tip:", expect.any(Error));
  });

  test("a failed transfer is reported through the command error handler", async () => {
    transferSol.mockImplementation(async () => {
      throw new Error("blockhash not found");
    });

    await tip("/tip 2", { replyFrom: { id: TARGET, is_bot: false, first_name: "T" } });

    expect(errorSpy).toHaveBeenCalledWith("Error in tip command:", expect.any(Error));
  });

  test("an @username typed without an entity is still resolved and removed from the amount", async () => {
    lookups["@bob"] = String(TARGET);

    await tip("/tip 2 @bob SOL");

    expect(parseCalls[0]?.[0]).toEqual(["/tip", "2", "SOL"]);
    expect(parseCalls[0]?.slice(2)).toEqual([CHAT, "tip"]);
    // The typed name found this account; it proves nothing to save.
    expect(primed).toEqual([]);
    expect(loosePrimed).toEqual([]);
    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to @bob…");
  });

  test("a mention entity pointing past the text is ignored in favour of the typed username", async () => {
    lookups["@bob"] = String(TARGET);

    await tip("/tip @bob 2", { entities: [{ type: "mention", offset: 400, length: 4 }] });

    expect(parseCalls[0]?.[0]).toEqual(["/tip", "2"]);
  });

  test("entities without a type are skipped", async () => {
    lookups["@bob"] = String(TARGET);
    const text = "/tip @bob 2";

    await tip(text, { entities: [{ offset: 5, length: 4 }, mentionEntity(text, "@bob")] });

    expect(parseCalls[0]?.[0]).toEqual(["/tip", "2"]);
  });

  test("a multi-word text mention is removed from the amount and uses the user's username", async () => {
    const text = "/tip Ana Maria 2 SOL";

    await tip(text, {
      entities: [
        {
          type: "text_mention",
          offset: 5,
          length: 9,
          user: { id: TARGET, is_bot: false, first_name: "Ana", username: "ana" },
        },
      ],
    });

    expect(parseCalls[0]?.[0]).toEqual(["/tip", "2", "SOL"]);
    expect(primed).toContainEqual([String(TARGET), "@ana"]);
    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to @ana…");
  });

  test("an @word typed next to a picked user without a username is not saved as theirs", async () => {
    const text = "/tip Ana 2 @bob";

    await tip(text, {
      entities: [
        {
          type: "text_mention",
          offset: 5,
          length: 3,
          user: { id: TARGET, is_bot: false, first_name: "Ana" },
        },
      ],
    });

    expect(primed).toEqual([]);
    expect(loosePrimed).toEqual([]);
  });

  test("a picked user whose name starts with @ is not saved under that name", async () => {
    const text = "/tip @bob 2";

    await tip(text, {
      entities: [
        { type: "text_mention", offset: 5, length: 4, user: { id: TARGET, is_bot: false } },
      ],
    });

    expect(primed).toEqual([]);
    expect(loosePrimed).toEqual([]);
  });

  test("a text mention covering an @handle uses that handle", async () => {
    const text = "/tip @ana 2";

    await tip(text, {
      entities: [
        { type: "text_mention", offset: 5, length: 4, user: { id: TARGET, is_bot: false } },
      ],
    });

    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to @ana…");
  });

  test("a text mention without usable offsets falls back to chat member details", async () => {
    overrideApiMethod("getChatMember", (payload) => ({
      status: "member",
      user: { id: payload.user_id, is_bot: false, first_name: "Marta", username: "marta" },
    }));

    await tip("/tip 2 SOL", {
      entities: [{ type: "text_mention", user: { id: TARGET, is_bot: false } }],
    });

    expect(primed).toContainEqual([String(TARGET), "@marta"]);
    // Without a known position nothing is stripped from the amount arguments.
    expect(parseCalls[0]?.[0]).toEqual(["/tip", "2", "SOL"]);
  });

  test("chat member first names are used when there is no username", async () => {
    await tip("/tip 2", {
      entities: [
        { type: "text_mention", offset: -1, length: 3, user: { id: TARGET, is_bot: false } },
      ],
    });

    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to Member…");
  });

  test("a text mention with a zero length keeps the amount arguments intact", async () => {
    const text = "/tip Zed 2";

    await tip(text, {
      entities: [
        {
          type: "text_mention",
          offset: 5,
          length: 0,
          user: { id: TARGET, is_bot: false, first_name: "Zed" },
        },
      ],
    });

    // Index 1 with a default single-token span removes "Zed".
    expect(parseCalls[0]?.[0]).toEqual(["/tip", "2"]);
    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to Zed…");
  });

  test("a whitespace-only text mention is treated as a single token", async () => {
    const text = "/tip   Zed 2";

    await tip(text, {
      entities: [
        {
          type: "text_mention",
          offset: 4,
          length: 2,
          user: { id: TARGET, is_bot: false, first_name: "Zed" },
        },
      ],
    });

    expect(parseCalls[0]?.[0]).toEqual(["/tip", "2"]);
  });

  test("chat member lookup failures do not block the tip", async () => {
    failApiMethod("getChatMember", "Bad Request: user not found");
    lookups["@bob"] = String(TARGET);
    const text = "/tip @bob 2";

    await tip(text, { entities: [mentionEntity(text, "@bob")] });

    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to @bob…");
  });

  test("usernames resolving to ids beyond the safe integer range skip the member lookup", async () => {
    lookups["@huge"] = "123456789012345678901234567890";
    const text = "/tip @huge 2";

    await tip(text, { entities: [mentionEntity(text, "@huge")] });

    expect(callsTo("getChatMember")).toHaveLength(0);
  });
});

describe("/tip when the usernames cannot be read", () => {
  test("a failed username read is raised, never answered as an unknown user", async () => {
    botModule.__test_setGameManager({
      findTelegramIdByUsername: () => {
        throw new Error("synthetic-db-down");
      },
      primeUsernameCache: () => {},
    } as any);
    const text = "/tip @bob 1";

    await tip(text, { entities: [mentionEntity(text, "@bob")] });

    expect(errorSpy).toHaveBeenCalledWith(
      "Error in text input handler:",
      expect.objectContaining({ message: "synthetic-db-down" }),
    );
    expect(texts()).toEqual([]);
  });
});

describe("/tip to a mentioned username", () => {
  test("pays the account the username names, under the username that was written", async () => {
    lookups["@bob"] = String(TARGET);
    overrideApiMethod("getChatMember", (payload) => ({
      status: "member",
      user: { id: payload.user_id, is_bot: false, first_name: "Member", username: "someone_else" },
    }));
    const text = "/tip @bob 2";

    await tip(text, { entities: [mentionEntity(text, "@bob")] });

    expect(primed).toEqual([]);
    expect(loosePrimed).toEqual([]);
    expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to @bob…");
    expect(callsTo("sendMessage").at(-1)!.payload.chat_id).toBe(TARGET);
  });
});
