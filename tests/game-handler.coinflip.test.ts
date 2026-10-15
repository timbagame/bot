import { describe, expect, test } from "bun:test";
import { handleCoinflipCommand } from "../src/handlers/game";
import { createTelegramContext } from "./helpers/fixtures";

describe("game handler: coinflip command", () => {
  test("allows game creation in private chat (forced public)", async () => {
    const ctx: any = createTelegramContext("/cf 10", "private");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => false,
      showInteractiveSetup: async () => {
        interactiveCalls.push(true);
      },
      createGameViaCommand: async () => {
        commandCalls.push(true);
      },
      resolveTokenOverride: async () => null,
    };

    await handleCoinflipCommand(ctx, deps);

    // DM games are now allowed - should proceed to command handler
    expect(ctx.__calls.length).toBe(0);
    expect(interactiveCalls.length).toBe(0);
    expect(commandCalls.length).toBe(1);
  });

  test("no args opens interactive setup", async () => {
    const ctx: any = createTelegramContext("/cf");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async (_ctx: any, telegramId: bigint) => {
        interactiveCalls.push([_ctx, telegramId]);
      },
      createGameViaCommand: async () => {
        commandCalls.push(true);
      },
      resolveTokenOverride: async () => null,
    };

    await handleCoinflipCommand(ctx, deps);

    expect(interactiveCalls.length).toBe(1);
    expect(interactiveCalls[0][0]).toBe(ctx);
    expect(interactiveCalls[0][1]).toBe(1n);
    expect(commandCalls.length).toBe(0);
    expect(ctx.__calls.length).toBe(0);
  });

  test("arguments delegate to command handler", async () => {
    const ctx: any = createTelegramContext("/cf 25");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async (forwardedCtx: any, telegramId: bigint, override?: any) => {
        interactiveCalls.push({ forwardedCtx, telegramId, override });
      },
      createGameViaCommand: async (forwardedCtx: any, args: string[], telegramId: bigint) => {
        commandCalls.push({ forwardedCtx, args, telegramId });
      },
      resolveTokenOverride: async () => null,
    };

    await handleCoinflipCommand(ctx, deps);

    expect(interactiveCalls.length).toBe(0);
    expect(commandCalls.length).toBe(1);
    expect(commandCalls[0].forwardedCtx).toBe(ctx);
    expect(commandCalls[0].args).toEqual(["/cf", "25"]);
    expect(commandCalls[0].telegramId).toBe(1n);
  });

  test("token-only argument opens interactive setup with override", async () => {
    const ctx: any = createTelegramContext("/cf TIMBA");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async (forwardedCtx: any, telegramId: bigint, override?: any) => {
        interactiveCalls.push({ forwardedCtx, telegramId, override });
      },
      createGameViaCommand: async () => {
        commandCalls.push(true);
      },
      resolveTokenOverride: async (tokenInput: string) => {
        if (tokenInput === "TIMBA") {
          return {
            tokenMint: "TIMBA_MINT",
            tokenTicker: "TIMBA",
            tokenDecimals: 6,
          };
        }
        return null;
      },
    };

    await handleCoinflipCommand(ctx, deps);

    expect(commandCalls.length).toBe(0);
    expect(interactiveCalls.length).toBe(1);
    expect(interactiveCalls[0].forwardedCtx).toBe(ctx);
    expect(interactiveCalls[0].telegramId).toBe(1n);
    expect(interactiveCalls[0].override).toEqual({
      tokenMint: "TIMBA_MINT",
      tokenTicker: "TIMBA",
      tokenDecimals: 6,
    });
  });

  const recordingDeps = (resolved: unknown = null) => {
    const calls = { interactive: 0, command: 0, resolved: [] as unknown[][] };
    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async () => {
        calls.interactive += 1;
      },
      createGameViaCommand: async () => {
        calls.command += 1;
      },
      resolveTokenOverride: async (...args: unknown[]) => {
        calls.resolved.push(args);
        return resolved;
      },
    };
    return { deps, calls };
  };

  test("unknown token-only argument is rejected without opening setup", async () => {
    const ctx: any = createTelegramContext("/cf NOPE");
    const { deps, calls } = recordingDeps(null);

    await handleCoinflipCommand(ctx, deps);

    expect(calls.resolved).toEqual([["NOPE", 100]]);
    expect(calls.interactive).toBe(0);
    expect(calls.command).toBe(0);
    expect(ctx.__calls).toEqual([["reply", "Token unavailable. Check its symbol or address."]]);
  });

  test("does nothing but explain when the sender cannot be identified", async () => {
    const ctx: any = createTelegramContext("/cf 10", "group", { from: undefined });
    const { deps, calls } = recordingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(calls.interactive).toBe(0);
    expect(calls.command).toBe(0);
    expect(ctx.__calls).toHaveLength(1);
    expect(ctx.__calls[0][1]).toContain("Unable to resolve your Telegram identity");
  });

  test("treats a message without text as a bare command", async () => {
    const ctx: any = createTelegramContext("", "group", {
      message: { message_id: 1, date: 0, chat: { id: 100 } } as any,
    });
    const { deps, calls } = recordingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(calls.resolved).toEqual([]);
    expect(calls.interactive).toBe(1);
  });

  test("a menu-only coinflip replying to someone asks for the amount instead of opening a game", async () => {
    const ctx: any = createTelegramContext("/cf TKN");
    ctx.message.reply_to_message = {
      message_id: 9,
      from: { id: 5150, is_bot: false, first_name: "Ana" },
    };
    const opened: unknown[] = [];
    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async () => {
        opened.push("menu");
      },
      createGameViaCommand: async () => {
        opened.push("game");
      },
      resolveTokenOverride: async () => {
        opened.push("token");
        return null;
      },
    };

    await handleCoinflipCommand(ctx, deps);

    expect(opened).toEqual([]);
    expect(ctx.__calls).toEqual([
      [
        "reply",
        "To challenge someone, reply to their message with <code>/cf &lt;amount&gt; [TOKEN]</code>.",
        { parse_mode: "HTML" },
      ],
    ]);
  });

  test.each(["/cf 10", "/cf"])(
    "%s replying to a message from another chat or topic is refused instead of opening a game",
    async (text) => {
      const ctx: any = createTelegramContext(text);
      ctx.message.external_reply = {
        origin: {
          type: "user",
          date: 0,
          sender_user: { id: 5150, is_bot: false, first_name: "Ana" },
        },
      };
      const opened: unknown[] = [];
      const deps: any = {
        isGroupChat: () => true,
        showInteractiveSetup: async () => {
          opened.push("menu");
        },
        createGameViaCommand: async () => {
          opened.push("game");
        },
        resolveTokenOverride: async () => null,
      };

      await handleCoinflipCommand(ctx, deps);

      expect(opened).toEqual([]);
      expect(ctx.__calls).toEqual([
        ["reply", "To challenge someone, reply to their message in this chat and topic."],
      ]);
    },
  );
});

describe("game handler: coinflip naming who to challenge", () => {
  const RIVAL = { id: 5150, is_bot: false, first_name: "Ana" };
  // Telegram reports @rival as a member of the group.
  const telegramContext = (...args: Parameters<typeof createTelegramContext>) => {
    const ctx: any = createTelegramContext(...args);
    ctx.api = {
      getChatMember: async () => ({ status: "member", user: { ...RIVAL, username: "rival" } }),
    };
    return ctx;
  };
  const CHALLENGE = { telegramId: "5150", displayName: "@rival" };
  const namingDeps = (found: string | null = "5150") => {
    const created: unknown[][] = [];
    const lookups: string[] = [];
    const deps: any = {
      isGroupChat: (ctx: any) => ctx.chat?.type !== "private",
      showInteractiveSetup: async () => {
        created.push(["menu"]);
      },
      createGameViaCommand: async (_ctx: any, ...args: unknown[]) => {
        created.push(args);
      },
      resolveTokenOverride: async () => null,
      usernames: {
        findTelegramIdByUsername: (username: string) => {
          lookups.push(username);
          return found;
        },
      },
    };
    return { deps, created, lookups };
  };

  test.each([
    ["/cf 100 @rival", ["/cf", "100"]],
    ["/cf @rival 100", ["/cf", "100"]],
    ["/cf @rival $1", ["/cf", "$1"]],
    ["/cf $1 @rival", ["/cf", "$1"]],
    ["/cf 1 USD @rival", ["/cf", "1", "USD"]],
    ["/cf 100 TIMBA @rival", ["/cf", "100", "TIMBA"]],
  ])("%s challenges the named user with the rest of the command", async (text, args) => {
    const ctx: any = telegramContext(text);
    const { deps, created, lookups } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(lookups).toEqual(["@rival"]);
    expect(created).toEqual([[args, 1n, CHALLENGE]]);
    expect(ctx.__calls).toEqual([]);
  });

  test.each(["/cf 100 @rival", "/cf 100 SOL @rival"])(
    "%s replying to someone else is refused instead of challenging either of them",
    async (text) => {
      const ctx: any = telegramContext(text);
      ctx.message.reply_to_message = {
        message_id: 9,
        from: { id: 6160, is_bot: false, first_name: "Bo" },
      };
      const { deps, created, lookups } = namingDeps();

      await handleCoinflipCommand(ctx, deps);

      expect(lookups).toEqual([]);
      expect(created).toEqual([]);
      expect(ctx.__calls).toEqual([
        ["reply", "To challenge someone, reply to their message or name them without replying."],
      ]);
    },
  );

  test("a reply naming the replied user challenges them without the name as a token", async () => {
    const ctx: any = telegramContext("/cf 100 SOL @Rival");
    ctx.message.reply_to_message = { message_id: 9, from: { ...RIVAL, username: "rival" } };
    const { deps, created, lookups } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(lookups).toEqual([]);
    expect(created).toEqual([[["/cf", "100", "SOL"], 1n]]);
    expect(ctx.__calls).toEqual([]);
  });

  test("a name sent as a reply to a bot, oneself or a channel is refused instead of opening a game", async () => {
    for (const [replied, answer] of [
      [
        { message_id: 9, from: { id: 7171, is_bot: true, first_name: "Bot" } },
        "You can't challenge a bot.",
      ],
      [
        { message_id: 9, from: { id: 1, is_bot: false, first_name: "Me" } },
        "You can't challenge yourself.",
      ],
      [
        {
          message_id: 9,
          from: { id: 1087968824, is_bot: true, first_name: "Group" },
          sender_chat: { id: -100, type: "supergroup", title: "Group" },
        },
        "To challenge someone, reply to their message or name them without replying.",
      ],
    ] as const) {
      const ctx: any = telegramContext("/cf 5 USDC @rival");
      ctx.message.reply_to_message = replied;
      const { deps, created, lookups } = namingDeps();

      await handleCoinflipCommand(ctx, deps);

      expect(lookups).toEqual([]);
      expect(created).toEqual([]);
      expect(ctx.__calls).toEqual([["reply", answer]]);
    }
  });

  test("the same replies without a name still open a regular coinflip", async () => {
    const ctx: any = telegramContext("/cf 5 USDC");
    ctx.message.reply_to_message = {
      message_id: 9,
      from: { id: 7171, is_bot: true, first_name: "Bot" },
    };
    const { deps, created } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(created).toEqual([[["/cf", "5", "USDC"], 1n]]);
  });

  test("inside a forum topic the name is still read", async () => {
    const ctx: any = telegramContext("/cf 100 @rival");
    ctx.message.reply_to_message = {
      message_id: 9,
      from: RIVAL,
      forum_topic_created: { name: "synthetic-topic", icon_color: 7322096 },
    };
    const { deps, created } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(created).toEqual([[["/cf", "100"], 1n, CHALLENGE]]);
  });

  test("a reply to another chat does not stop a named challenge, as /tip ignores it too", async () => {
    const ctx: any = telegramContext("/cf 100 @rival");
    ctx.message.external_reply = { origin: { type: "user", date: 0, sender_user: RIVAL } };
    const { deps, created } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(created).toEqual([[["/cf", "100"], 1n, CHALLENGE]]);
  });

  test("an unknown name is answered and no game is opened", async () => {
    const ctx: any = telegramContext("/cf 100 @ghost");
    const { deps, created } = namingDeps(null);

    await handleCoinflipCommand(ctx, deps);

    expect(created).toEqual([]);
    expect(ctx.__calls).toEqual([
      [
        "reply",
        "I don't know who <code>@ghost</code> is. Reply to one of their messages to challenge them.",
        { parse_mode: "HTML" },
      ],
    ]);
  });

  test("naming oneself is refused", async () => {
    const ctx: any = telegramContext("/cf 100 @alice");
    const { deps, created } = namingDeps("1");

    await handleCoinflipCommand(ctx, deps);

    expect(created).toEqual([]);
    expect(ctx.__calls).toEqual([
      ["reply", "You can't challenge yourself.", { parse_mode: "HTML" }],
    ]);
  });

  test("someone who left the group is still challenged, as /tip still pays them", async () => {
    const ctx: any = telegramContext("/cf 100 @rival");
    ctx.api.getChatMember = async () => ({ status: "left", user: { ...RIVAL, username: "rival" } });
    const { deps, created } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(created).toEqual([[["/cf", "100"], 1n, CHALLENGE]]);
    expect(ctx.__calls).toEqual([]);
  });

  test("a name without an amount asks for one before looking anyone up", async () => {
    const ctx: any = telegramContext("/cf @rival TIMBA");
    const { deps, created, lookups } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(lookups).toEqual([]);
    expect(created).toEqual([]);
    expect(ctx.__calls).toEqual([
      [
        "reply",
        "To challenge someone by name, use <code>/cf &lt;amount&gt; [TOKEN] @username</code>.",
        { parse_mode: "HTML" },
      ],
    ]);
  });

  test("in a private chat a name is refused instead of opening a public game", async () => {
    const ctx: any = telegramContext("/cf 100 @rival", "private");
    const { deps, created, lookups } = namingDeps();

    await handleCoinflipCommand(ctx, deps);

    expect(lookups).toEqual([]);
    expect(created).toEqual([]);
    expect(ctx.__calls).toEqual([["reply", "Challenges only work in groups."]]);
  });
});
