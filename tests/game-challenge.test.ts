import { describe, expect, spyOn, test } from "bun:test";
import {
  CHALLENGE_IN_GROUPS_MESSAGE,
  CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE,
  CHALLENGE_NEEDS_AMOUNT_MESSAGE,
  CHALLENGE_PLAYERS,
  challengeForSomeoneElseMessage,
  findChallengeName,
  namedReplyRefusal,
  resolveChallengeTarget,
  resolveNamedChallenge,
} from "../src/utils/game-challenge";

const CREATOR = 4242n;
const reply = (replyToMessage: Record<string, unknown>) =>
  ({ reply_to_message: replyToMessage }) as any;

describe("resolveChallengeTarget", () => {
  test("a reply to a user with a username challenges them by @username", () => {
    expect(
      resolveChallengeTarget(
        reply({ from: { id: 5150, is_bot: false, first_name: "Rival", username: "rival" } }),
        CREATOR,
      ),
    ).toEqual({ telegramId: "5150", displayName: "@rival" });
  });

  test("a reply to a user without a username challenges them by full name", () => {
    expect(
      resolveChallengeTarget(
        reply({ from: { id: 6160, is_bot: false, first_name: "Ana", last_name: "Paz" } }),
        CREATOR,
      ),
    ).toEqual({ telegramId: "6160", displayName: "Ana Paz" });
  });

  test("a command that replies to nothing is not a challenge", () => {
    expect(resolveChallengeTarget({} as any, CREATOR)).toBeNull();
    expect(resolveChallengeTarget(undefined, CREATOR)).toBeNull();
  });

  test("a reply without a sender is not a challenge", () => {
    expect(resolveChallengeTarget(reply({ text: "synthetic" }), CREATOR)).toBeNull();
  });

  test("a reply to a bot is not a challenge", () => {
    expect(
      resolveChallengeTarget(
        reply({ from: { id: 7171, is_bot: true, first_name: "Bot" } }),
        CREATOR,
      ),
    ).toBeNull();
  });

  test("a reply to one's own message is not a challenge", () => {
    expect(
      resolveChallengeTarget(
        reply({ from: { id: Number(CREATOR), is_bot: false, first_name: "Me" } }),
        CREATOR,
      ),
    ).toBeNull();
  });

  test("the implicit reply to a forum topic's opening message is not a challenge", () => {
    expect(
      resolveChallengeTarget(
        reply({
          from: { id: 8181, is_bot: false, first_name: "Topic Owner" },
          forum_topic_created: { name: "synthetic-topic", icon_color: 7322096 },
        }),
        CREATOR,
      ),
    ).toBeNull();
  });

  test("a reply to a channel post or anonymous admin is not a challenge", () => {
    expect(
      resolveChallengeTarget(
        reply({
          from: { id: 777000, is_bot: false, first_name: "Telegram" },
          sender_chat: { id: -1009191, type: "channel", title: "synthetic-channel" },
        }),
        CREATOR,
      ),
    ).toBeNull();
  });
});

describe("challenge texts", () => {
  test("someone else tapping Accept is told who the challenge is for", () => {
    expect(challengeForSomeoneElseMessage({ telegramId: "5150", displayName: "Ana Paz" })).toBe(
      "This challenge is for Ana Paz.",
    );
  });

  test("a challenge is one on one and the menu reply asks for an amount", () => {
    expect(CHALLENGE_PLAYERS).toBe(2);
    expect(CHALLENGE_NEEDS_AMOUNT_MESSAGE).toBe(
      "To challenge someone, reply to their message with <code>/cf &lt;amount&gt; [TOKEN]</code>.",
    );
  });
});

describe("findChallengeName", () => {
  const text = "/cf 5 @rival";

  test("a command that replies to no one is read for a name", () => {
    expect(findChallengeName({ text } as any)).toEqual({
      user: null,
      username: "@rival",
      label: null,
      args: ["/cf", "5"],
      positions: [0, 1],
    });
  });

  test("a reply goes to whoever it answers, so the name is not read", () => {
    for (const from of [
      { id: 5150, is_bot: false, first_name: "Ana" },
      { id: 7171, is_bot: true, first_name: "Bot" },
      { id: Number(CREATOR), is_bot: false, first_name: "Me" },
    ]) {
      expect(findChallengeName({ text, ...reply({ from }) })).toBeNull();
    }
  });

  test("the implicit reply to a forum topic or a reply without a sender still reads the name", () => {
    expect(
      findChallengeName({
        text,
        ...reply({
          from: { id: 8181, is_bot: false, first_name: "Topic Owner" },
          forum_topic_created: { name: "synthetic-topic", icon_color: 7322096 },
        }),
      })?.username,
    ).toBe("@rival");
    expect(findChallengeName({ text, ...reply({ text: "synthetic" }) })?.username).toBe("@rival");
  });
});

describe("namedReplyRefusal", () => {
  const text = "/cf 5 @rival";
  const me = { id: Number(CREATOR), is_bot: false, first_name: "Me" };

  test("a name replying to a bot, oneself, a channel or an anonymous admin is refused", () => {
    expect(
      namedReplyRefusal(
        { text, ...reply({ from: { id: 7171, is_bot: true, first_name: "Bot" } }) },
        CREATOR,
      ),
    ).toBe("You can't challenge a bot.");
    expect(namedReplyRefusal({ text, ...reply({ from: me }) }, CREATOR)).toBe(
      "You can't challenge yourself.",
    );
    expect(
      namedReplyRefusal(
        {
          text,
          ...reply({
            from: { id: 136817688, is_bot: true, first_name: "Channel" },
            sender_chat: { id: -1009, type: "channel", title: "News" },
          }),
        },
        CREATOR,
      ),
    ).toBe("To challenge someone, reply to their message or name them without replying.");
  });

  test("a reply to someone who can be challenged, or a reply without a name, is not refused", () => {
    expect(
      namedReplyRefusal(
        { text, ...reply({ from: { id: 5150, is_bot: false, first_name: "Ana" } }) },
        CREATOR,
      ),
    ).toBeNull();
    expect(namedReplyRefusal({ text: "/cf 5", ...reply({ from: me }) }, CREATOR)).toBeNull();
  });

  test("no reply, a reply without a sender or a forum topic's opening message is not refused", () => {
    expect(namedReplyRefusal({ text } as any, CREATOR)).toBeNull();
    expect(namedReplyRefusal(undefined, CREATOR)).toBeNull();
    expect(namedReplyRefusal({ text, ...reply({ text: "synthetic" }) }, CREATOR)).toBeNull();
    expect(
      namedReplyRefusal(
        {
          text,
          ...reply({
            from: me,
            forum_topic_created: { name: "synthetic-topic", icon_color: 7322096 },
          }),
        },
        CREATOR,
      ),
    ).toBeNull();
  });
});

describe("resolveNamedChallenge", () => {
  const named = (overrides: Record<string, unknown> = {}) =>
    ({
      user: null,
      username: "@rival",
      args: ["/cf", "5"],
      positions: [0, 1],
      ...overrides,
    }) as any;
  const users = (found: string | null | Error) => ({
    findTelegramIdByUsername: () => {
      if (found instanceof Error) throw found;
      return found;
    },
  });
  const RIVAL = { id: 5150, is_bot: false, first_name: "Rival", username: "Rival" };
  /** Telegram answering getChatMember with this member, or failing with this error. */
  const telegram = (answer: Record<string, unknown> | Error) =>
    ({
      chat: { id: -100 },
      api: {
        getChatMember: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    }) as any;
  const member = (user: Record<string, unknown> = RIVAL) =>
    telegram({ status: "member", user: { is_bot: false, ...user } });
  const telegramError = (code: number, description: string) =>
    Object.assign(new Error(description), { error_code: code, description });

  test("a typed username whose account is in the group is challenged by Telegram's name", async () => {
    expect(await resolveNamedChallenge(member(), named(), CREATOR, users("5150"))).toEqual({
      challenge: { telegramId: "5150", displayName: "@Rival" },
    });
  });

  test("a picked user without a username is challenged by full name", async () => {
    const user = { id: 6160, is_bot: false, first_name: "Ana", last_name: "Paz" };
    expect(
      await resolveNamedChallenge(
        member({ id: 6160 }),
        named({ user, username: null }),
        CREATOR,
        users(null),
      ),
    ).toEqual({ challenge: { telegramId: "6160", displayName: "Ana Paz" } });
  });

  test("a picked user with no name at all is called Player", async () => {
    expect(
      await resolveNamedChallenge(
        member({ id: 6160 }),
        named({ user: { id: 6160, is_bot: false }, username: null }),
        CREATOR,
        users(null),
      ),
    ).toEqual({ challenge: { telegramId: "6160", displayName: "Player" } });
  });

  test("as with /tip, whatever Telegram says about the account, it is challenged", async () => {
    for (const status of ["creator", "member", "left", "kicked"]) {
      expect(
        await resolveNamedChallenge(
          telegram({ status, user: RIVAL }),
          named(),
          CREATOR,
          users("5150"),
        ),
      ).toEqual({ challenge: { telegramId: "5150", displayName: "@Rival" } });
    }
    // A stored mapping cannot override Telegram's current username.
    expect(
      await resolveNamedChallenge(
        member({ ...RIVAL, username: "someone_else" }),
        named(),
        CREATOR,
        users("5150"),
      ),
    ).toEqual({
      refusal:
        "I couldn't verify <code>@rival</code>. Reply to their message or pick them from Telegram's mention list.",
    });
  });

  test("a typed username cannot name the rival when Telegram cannot verify it", async () => {
    for (const failure of [
      telegramError(400, "Bad Request: user not found"),
      telegramError(429, "Too Many Requests: retry after 5"),
      new Error("synthetic-network-down"),
    ]) {
      expect(
        await resolveNamedChallenge(telegram(failure), named(), CREATOR, users("5150")),
      ).toEqual({
        refusal:
          "I couldn't verify <code>@rival</code>. Reply to their message or pick them from Telegram's mention list.",
      });
    }
    // Ids past the safe integer range are not asked about at all.
    expect(
      await resolveNamedChallenge(
        member(),
        named(),
        CREATOR,
        users("123456789012345678901234567890"),
      ),
    ).toEqual({
      refusal:
        "I couldn't verify <code>@rival</code>. Reply to their message or pick them from Telegram's mention list.",
    });
  });

  test("each name that cannot be challenged gets its own answer", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await resolveNamedChallenge(
          member(),
          named({ username: "@gh<o>st" }),
          CREATOR,
          users(null),
        ),
      ).toEqual({
        refusal:
          "I don't know who <code>@gh&lt;o&gt;st</code> is. Reply to one of their messages to challenge them.",
      });
      const failure = new Error("synthetic-db-down");
      expect(
        await resolveNamedChallenge(member(), named({ username: "@a&b" }), CREATOR, users(failure)),
      ).toEqual({
        refusal:
          "I couldn't look up <code>@a&amp;b</code>. Try again, or reply to one of their messages.",
      });
      expect(error).toHaveBeenCalledWith("Failed to look up the challenged user:", failure);
      expect(
        await resolveNamedChallenge(member(), named(), CREATOR, users("synthetic-id")),
      ).toEqual({
        refusal: "I couldn't tell who that is. Reply to one of their messages to challenge them.",
      });
      expect(
        await resolveNamedChallenge(member(), named(), CREATOR, users(String(CREATOR))),
      ).toEqual({ refusal: "You can't challenge yourself." });
      expect(
        await resolveNamedChallenge(
          member({ ...RIVAL, is_bot: true }),
          named(),
          CREATOR,
          users("5150"),
        ),
      ).toEqual({ refusal: "You can't challenge a bot." });
    } finally {
      error.mockRestore();
    }
  });

  test("the answers for naming someone in the wrong place", () => {
    expect(CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE).toBe(
      "To challenge someone by name, use <code>/cf &lt;amount&gt; [TOKEN] @username</code>.",
    );
    expect(CHALLENGE_IN_GROUPS_MESSAGE).toBe("Challenges only work in groups.");
  });
});
