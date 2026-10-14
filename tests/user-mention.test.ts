import { describe, expect, mock, test } from "bun:test";
import fc from "fast-check";
import {
  findNamedUser,
  replaceCommandWord,
  resolveNamedUser,
  type NamedUser,
} from "../src/utils/user-mention";

const SENDER = 4242n;
const command = (text: string, entities: unknown[] = []) =>
  ({
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }, ...entities],
  }) as any;
const mention = (text: string, word: string) => ({
  type: "mention",
  offset: text.indexOf(word),
  length: word.length,
});
const picked = (text: string, words: string, user: Record<string, unknown>) => ({
  type: "text_mention",
  offset: text.indexOf(words),
  length: words.length,
  user: { is_bot: false, ...user },
});

describe("findNamedUser", () => {
  test("a typed @username is found anywhere after the command and removed from the words", () => {
    for (const [text, args, positions] of [
      ["/cf 100 @ana", ["/cf", "100"], [0, 1]],
      ["/cf @ana $1", ["/cf", "$1"], [0, 2]],
      ["/cf 100 TIMBA @ana", ["/cf", "100", "TIMBA"], [0, 1, 2]],
      ["/cf 1 USD @ana 3", ["/cf", "1", "USD", "3"], [0, 1, 2, 4]],
    ] as const) {
      expect(findNamedUser(command(text))).toEqual({
        user: null,
        username: "@ana",
        label: null,
        args: [...args],
        positions: [...positions],
      });
    }
  });

  test("the first typed @username counts, never the command word itself", () => {
    expect(findNamedUser(command("/cf 5 @Ana @Bob"))?.username).toBe("@Ana");
    expect(findNamedUser({ text: "@ana 5" } as any)).toBeNull();
  });

  test("a bare @ or text without anyone names no one", () => {
    expect(findNamedUser(command("/cf 5 @"))).toBeNull();
    expect(findNamedUser(command("/cf 5 TIMBA"))).toBeNull();
    expect(findNamedUser(command(""))).toBeNull();
    expect(findNamedUser(undefined)).toBeNull();
    expect(findNamedUser({ text: "/cf 5 @ana", entities: "broken" } as any)?.username).toBe("@ana");
  });

  test("an @username Telegram marked is used with its words removed", () => {
    const text = "/cf 5 @Ana 3";
    expect(findNamedUser(command(text, [mention(text, "@Ana")]))).toEqual({
      user: null,
      username: "@Ana",
      label: "@Ana",
      args: ["/cf", "5", "3"],
      positions: [0, 1, 3],
    });
  });

  test("the first @username Telegram marked wins over later ones and over typed words", () => {
    const text = "/cf 5 @Ana @Bob";
    expect(findNamedUser(command(text, [mention(text, "@Bob"), mention(text, "@Ana")]))).toEqual({
      user: null,
      username: "@Bob",
      label: "@Bob",
      args: ["/cf", "5", "@Ana"],
      positions: [0, 1, 2],
    });
  });

  test("entities without a type or past the end of the text are skipped", () => {
    const text = "/cf 5 @ana";
    expect(
      findNamedUser(
        command(text, [
          { offset: 6, length: 4 },
          { type: "mention", offset: 400, length: 4 },
          { type: "mention" },
          { type: "text_mention", offset: 6, length: 4 },
        ]),
      ),
    ).toEqual({
      user: null,
      username: "@ana",
      label: null,
      args: ["/cf", "5"],
      positions: [0, 1],
    });
  });

  test("a user picked from the list wins, named by their @username, with their words removed", () => {
    const text = "/cf 5 Ana Paz TIMBA @bob";
    const user = {
      id: 5150,
      is_bot: false,
      first_name: "Ana",
      last_name: "Paz",
      username: "anapaz",
    };
    expect(
      findNamedUser(command(text, [picked(text, "Ana Paz", user), mention(text, "@bob")])),
    ).toEqual({
      user,
      username: "@anapaz",
      label: "Ana Paz",
      args: ["/cf", "5", "TIMBA", "@bob"],
      positions: [0, 1, 4, 5],
    });
    const plain = { id: 5150, is_bot: false, first_name: "Ana", last_name: "Paz" };
    expect(findNamedUser(command("/cf 5 Ana Paz TIMBA", [picked(text, "Ana Paz", plain)]))).toEqual(
      {
        user: plain,
        username: null,
        label: "Ana Paz",
        args: ["/cf", "5", "TIMBA"],
        positions: [0, 1, 4],
      },
    );
  });

  test("as in /tip, a picked user without an @username takes the first typed @word instead", () => {
    const text = "/cf 5 Ana @bob";
    const user = { id: 1, is_bot: false, first_name: "Ana" };
    expect(findNamedUser(command(text, [picked(text, "Ana", user)]))).toEqual({
      user,
      username: "@bob",
      label: "Ana",
      args: ["/cf", "5", "Ana"],
      positions: [0, 1, 2],
    });
  });

  test("a picked user's text starting with @ is their @username", () => {
    const text = "/cf 5 @Zed";
    const user = { id: 1, is_bot: false, first_name: "Zed" };
    expect(findNamedUser(command(text, [picked(text, "@Zed", user)]))).toMatchObject({
      username: "@Zed",
      label: "@Zed",
    });
  });

  test("a picked user whose words cannot be placed keeps every word", () => {
    const user = { id: 1, is_bot: false, first_name: "Zed" };
    expect(
      findNamedUser(
        command("/cf 5 TIMBA", [{ type: "text_mention", offset: -1, length: 3, user }]),
      ),
    ).toEqual({
      user,
      username: null,
      label: "Zed",
      args: ["/cf", "5", "TIMBA"],
      positions: [0, 1, 2],
    });
    expect(findNamedUser(command("/cf 5", [{ type: "text_mention", user }]))).toMatchObject({
      label: "Zed",
      args: ["/cf", "5"],
    });
  });

  test("a picked user over no words, or only spaces, removes the one word where it starts", () => {
    const user = { id: 1, is_bot: false, first_name: "Zed" };
    expect(
      findNamedUser(command("/cf Zed 5", [{ type: "text_mention", offset: 4, length: 0, user }])),
    ).toMatchObject({ args: ["/cf", "5"], positions: [0, 2] });
    expect(
      findNamedUser(command("/cf   Zed 5", [{ type: "text_mention", offset: 3, length: 2, user }])),
    ).toMatchObject({ label: "Zed", args: ["/cf", "5"], positions: [0, 2] });
    const nameless = { id: 1, is_bot: false };
    expect(
      findNamedUser(
        command("/cf Zed 5", [{ type: "text_mention", offset: 4, length: 0, user: nameless }]),
      ),
    ).toMatchObject({ label: null });
    expect(
      findNamedUser(
        command("/cf 5 Zed", [{ type: "text_mention", offset: 6, length: "x" as any, user }]),
      ),
    ).toMatchObject({ args: ["/cf", "5"], positions: [0, 1] });
  });

  test("a picked user at the very start never removes the command word", () => {
    const user = { id: 1, is_bot: false, first_name: "Zed" };
    expect(
      findNamedUser(command("/cf 5", [{ type: "text_mention", offset: 0, length: 3, user }]))?.args,
    ).toEqual(["/cf", "5"]);
  });
});

const named = (overrides: Partial<NamedUser> = {}): NamedUser => ({
  user: null,
  username: "@rival",
  label: "@rival",
  args: ["/cf", "5"],
  positions: [0, 1],
  ...overrides,
});

const context = (
  member: unknown = {
    status: "member",
    user: { id: 5150, is_bot: false, first_name: "Rival", username: "Rival" },
  },
) => {
  const getChatMember = mock(async () => {
    if (member instanceof Error) throw member;
    return member;
  });
  return { ctx: { chat: { id: -100 }, api: { getChatMember } } as any, getChatMember };
};

const directory = (found: string | null | Error = "5150") => ({
  findTelegramIdByUsername: mock((_username: string) => {
    if (found instanceof Error) throw found;
    return found;
  }),
});

describe("resolveNamedUser", () => {
  test("arbitrary handles are accepted only when Telegram reports the same owner and name", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z0-9_]{4,15}$/),
        fc.boolean(),
        async (handle, matches) => {
          const ctx = context({
            user: { id: 5150, is_bot: false, username: matches ? handle : `other_${handle}` },
          }).ctx;
          const result = await resolveNamedUser(
            ctx,
            named({ username: `@${handle.toUpperCase()}` }),
            SENDER,
            directory(),
          );
          expect(result.kind).toBe(matches ? "user" : "verification_failed");
        },
      ),
      { numRuns: 100 },
    );
  });

  test("fuzzed username text never verifies a different Telegram handle", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 100 }), async (input) => {
        const result = await resolveNamedUser(
          context().ctx,
          named({ username: input }),
          SENDER,
          directory(),
        );
        if (result.kind === "user")
          expect(input.trim().replace(/^@/, "").toLowerCase()).toBe("rival");
      }),
      { numRuns: 200 },
    );
  });

  test("a typed username is looked up and Telegram is asked for the details", async () => {
    const member = {
      status: "member",
      user: { id: 5150, is_bot: false, first_name: "Rival", username: "Rival" },
    };
    const { ctx, getChatMember } = context(member);
    const users = directory();

    expect(await resolveNamedUser(ctx, named(), SENDER, users)).toEqual({
      kind: "user",
      id: "5150",
      telegramId: 5150n,
      user: member.user,
      member: member.user,
    });
    expect(users.findTelegramIdByUsername).toHaveBeenCalledWith("@rival");
    expect(getChatMember).toHaveBeenCalledWith(-100, 5150);
  });

  test("a username nobody used is unknown", async () => {
    expect(
      await resolveNamedUser(context().ctx, named({ username: "@ghost" }), SENDER, directory(null)),
    ).toEqual({ kind: "unknown", username: "@ghost" });
  });

  test("a failed read is reported as such, not as an unknown username", async () => {
    const error = new Error("synthetic-db-down");
    const { ctx, getChatMember } = context();

    expect(await resolveNamedUser(ctx, named(), SENDER, directory(error))).toEqual({
      kind: "lookup_failed",
      username: "@rival",
      error,
    });
    expect(getChatMember).not.toHaveBeenCalled();
  });

  test("a stored id that is not a number cannot be used", async () => {
    expect(
      await resolveNamedUser(context().ctx, named(), SENDER, directory("synthetic-id")),
    ).toEqual({ kind: "unusable_id" });
  });

  test("naming oneself is refused before asking Telegram", async () => {
    const { ctx, getChatMember } = context();

    expect(await resolveNamedUser(ctx, named(), SENDER, directory(String(SENDER)))).toEqual({
      kind: "self",
    });
    expect(getChatMember).not.toHaveBeenCalled();
  });

  test("an account Telegram reports as a bot is refused", async () => {
    const { ctx } = context({ status: "member", user: { id: 5150, is_bot: true } });

    expect(await resolveNamedUser(ctx, named(), SENDER, directory())).toEqual({ kind: "bot" });
  });

  test("a picked bot is refused without a lookup or asking Telegram", async () => {
    const users = directory();
    const { ctx, getChatMember } = context();
    const user = { id: 7171, is_bot: true, first_name: "Robo" };

    expect(await resolveNamedUser(ctx, named({ user, username: null }), SENDER, users)).toEqual({
      kind: "bot",
    });
    expect(users.findTelegramIdByUsername).not.toHaveBeenCalled();
    expect(getChatMember).not.toHaveBeenCalled();
  });

  test("a picked user needs no lookup and keeps Telegram's details", async () => {
    const users = directory();
    const user = { id: 6160, is_bot: false, first_name: "Ana", username: "ana" };

    expect(
      await resolveNamedUser(context().ctx, named({ user, username: null }), SENDER, users),
    ).toEqual({
      kind: "user",
      id: "6160",
      telegramId: 6160n,
      user,
      member: { id: 5150, is_bot: false, first_name: "Rival", username: "Rival" },
    });
    expect(users.findTelegramIdByUsername).not.toHaveBeenCalled();
  });

  test("Telegram failing to answer blocks a typed username", async () => {
    const error = new Error("synthetic-not-found");

    expect(await resolveNamedUser(context(error).ctx, named(), SENDER, directory())).toEqual({
      kind: "verification_failed",
      username: "@rival",
    });
  });

  test("Telegram is not asked outside a chat, without an api or for ids past the safe range", async () => {
    const { getChatMember } = context();
    const users = directory("123456789012345678901234567890");

    const outsideChat = { api: { getChatMember } } as any;
    const withoutApi = { chat: { id: -100 } } as any;
    for (const ctx of [outsideChat, withoutApi]) {
      expect(await resolveNamedUser(ctx, named(), SENDER, directory())).toEqual({
        kind: "verification_failed",
        username: "@rival",
      });
    }
    const huge = await resolveNamedUser(
      { chat: { id: -100 }, api: { getChatMember } } as any,
      named(),
      SENDER,
      users,
    );

    expect(getChatMember).not.toHaveBeenCalled();
    expect(huge).toEqual({
      kind: "verification_failed",
      username: "@rival",
    });
  });

  test("mismatched and removed usernames are invalidated, even with poisoned legacy data", async () => {
    for (const username of ["someone_else", undefined]) {
      const users = { ...directory(), invalidateUsernameMapping: mock(() => {}) };
      const { ctx } = context({ user: { id: 5150, is_bot: false, username } });
      expect(await resolveNamedUser(ctx, named(), SENDER, users)).toEqual({
        kind: "verification_failed",
        username: "@rival",
      });
      expect(users.invalidateUsernameMapping).toHaveBeenCalledWith("@rival", "5150");
    }
  });

  test("a response for another account never verifies a username", async () => {
    const { ctx } = context({ user: { id: 6160, is_bot: false, username: "rival" } });
    expect(await resolveNamedUser(ctx, named(), SENDER, directory())).toEqual({
      kind: "verification_failed",
      username: "@rival",
    });
  });

  test("a failed invalidation stops resolution and a picked user survives a Telegram outage", async () => {
    const error = new Error("synthetic-delete-failed");
    const users = {
      ...directory(),
      invalidateUsernameMapping: () => {
        throw error;
      },
    };
    expect(
      await resolveNamedUser(
        context({ user: { id: 5150, username: "other" } }).ctx,
        named(),
        SENDER,
        users,
      ),
    ).toEqual({
      kind: "lookup_failed",
      username: "@rival",
      error,
    });
    const user = { id: 5150, is_bot: false, first_name: "Rival" };
    expect(
      await resolveNamedUser(context(error).ctx, named({ user }), SENDER, directory()),
    ).toMatchObject({
      kind: "user",
      telegramId: 5150n,
      user,
    });
  });
});

describe("replaceCommandWord", () => {
  test("swaps one word and moves the entities after it", () => {
    const text = "/cf  1 usdc @ana";
    const message = command(text, [mention(text, "@ana"), { type: "bold", offset: 7, length: 4 }]);

    expect(replaceCommandWord(message, 2, "sol-usdc")).toEqual({
      text: "/cf  1 sol-usdc @ana",
      entities: [
        { type: "bot_command", offset: 0, length: 3 },
        { type: "mention", offset: 16, length: 4 },
        { type: "bold", offset: 7, length: 4 },
      ],
    });
  });

  test("a shorter word moves later entities back, and no entities stay none", () => {
    const text = "/cf 1 usdc @ana";
    expect(replaceCommandWord(command(text, [mention(text, "@ana")]), 2, "u").entities).toEqual([
      { type: "bot_command", offset: 0, length: 3 },
      { type: "mention", offset: 8, length: 4 },
    ]);
    expect(replaceCommandWord({ text: "/cf TKN" } as any, 1, "mint")).toEqual({
      text: "/cf mint",
      entities: undefined,
    });
  });
});
