import { describe, expect, spyOn, test } from "bun:test";
import {
  CHALLENGE_IN_GROUPS_MESSAGE,
  CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE,
  CHALLENGE_NEEDS_AMOUNT_MESSAGE,
  challengeForSomeoneElseMessage,
  challengeKeepsOut,
  findChallengeNames,
  namedReplyRefusal,
  resolveChallengeTarget,
  resolveNamedChallenge,
  resolveNamedChallenges,
} from "../src/utils/game-challenge";
import { findNamedUsers } from "../src/utils/user-mention";

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
    const ana = { telegramId: "5150", displayName: "Ana Paz" };
    const bo = { telegramId: "6160", displayName: "@bo" };
    const cid = { telegramId: "7171", displayName: "Cid" };
    expect(challengeForSomeoneElseMessage([ana])).toBe("This challenge is for Ana Paz.");
    expect(challengeForSomeoneElseMessage([ana, bo])).toBe(
      "This challenge is for Ana Paz and @bo.",
    );
    expect(challengeForSomeoneElseMessage([ana, bo, cid])).toBe(
      "This challenge is for Ana Paz, @bo and Cid.",
    );
  });

  test("five of the longest usernames still fit in the answer to someone else", () => {
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((letter) => `@${letter.repeat(32)}`);
    const challenge = [a, b, c, d, e].map((displayName, index) => ({
      telegramId: String(5150 + index),
      displayName: displayName!,
    }));

    expect(challengeForSomeoneElseMessage(challenge)).toBe(
      `This challenge is for ${a}, ${b}, ${c}, ${d} and ${e}.`,
    );
  });

  test("names too long for Telegram's 200-character answer are left out", () => {
    // "This challenge is for " and "." take 23 of the 200.
    const named = (length: number) => [{ telegramId: "5150", displayName: "a".repeat(length) }];

    expect(challengeForSomeoneElseMessage(named(177))).toBe(
      `This challenge is for ${"a".repeat(177)}.`,
    );
    expect(challengeForSomeoneElseMessage(named(178))).toBe("This challenge isn't for you.");
  });

  test("the menu reply asks for an amount", () => {
    expect(CHALLENGE_NEEDS_AMOUNT_MESSAGE).toBe(
      "To challenge someone, reply to their message with <code>/cf &lt;amount&gt; [TOKEN]</code>.",
    );
  });
});

describe("challengeKeepsOut", () => {
  const challenge = [
    { telegramId: "5150", displayName: "@rival" },
    { telegramId: "6160", displayName: "@bo" },
  ];

  test("a challenge keeps out everyone it does not name", () => {
    expect(challengeKeepsOut(challenge, 5150n)).toBe(false);
    expect(challengeKeepsOut(challenge, 6160n)).toBe(false);
    expect(challengeKeepsOut(challenge, 7171n)).toBe(true);
    expect(challengeKeepsOut(challenge, CREATOR)).toBe(true);
  });

  test("a game without a challenge keeps no one out", () => {
    expect(challengeKeepsOut([], 7171n)).toBe(false);
  });
});

describe("findChallengeNames", () => {
  const text = "/cf 5 @rival";

  test("a command that replies to no one is read for every name", () => {
    expect(findChallengeNames({ text } as any)).toEqual({
      users: [{ user: null, username: "@rival", label: null }],
      args: ["/cf", "5"],
      positions: [0, 1],
    });
    expect(findChallengeNames({ text: "/cf 5 @rival TKN @bo" } as any)).toEqual({
      users: [
        { user: null, username: "@rival", label: null },
        { user: null, username: "@bo", label: null },
      ],
      args: ["/cf", "5", "TKN"],
      positions: [0, 1, 3],
    });
  });

  test("a reply goes to whoever it answers, so the name is not read", () => {
    for (const from of [
      { id: 5150, is_bot: false, first_name: "Ana" },
      { id: 7171, is_bot: true, first_name: "Bot" },
      { id: Number(CREATOR), is_bot: false, first_name: "Me" },
    ]) {
      expect(findChallengeNames({ text, ...reply({ from }) })).toBeNull();
    }
  });

  test("the implicit reply to a forum topic or a reply without a sender still reads the name", () => {
    const rivalOnly = findNamedUsers({ text } as any);
    expect(
      findChallengeNames({
        text,
        ...reply({
          from: { id: 8181, is_bot: false, first_name: "Topic Owner" },
          forum_topic_created: { name: "synthetic-topic", icon_color: 7322096 },
        }),
      }),
    ).toEqual(rivalOnly);
    expect(findChallengeNames({ text, ...reply({ text: "synthetic" }) })).toEqual(rivalOnly);
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

  test("a name replying to someone else is refused instead of challenging the reply", () => {
    for (const command of [text, "/cf 5 SOL @rival", "/cf 5 SOL 2 @rival"]) {
      expect(
        namedReplyRefusal(
          { text: command, ...reply({ from: { id: 5150, is_bot: false, first_name: "Ana" } }) },
          CREATOR,
        ),
      ).toBe("To challenge someone, reply to their message or name them without replying.");
    }
  });

  test("a reply naming the replied user and anyone else is refused, wherever the other name is", () => {
    const rival = { id: 5150, is_bot: false, first_name: "Ana", username: "Rival" };
    for (const command of ["/cf 5 @rival @bo", "/cf 5 @bo SOL @rival"]) {
      expect(namedReplyRefusal({ text: command, ...reply({ from: rival }) }, CREATOR)).toBe(
        "To challenge someone, reply to their message or name them without replying.",
      );
    }
  });

  test("a reply naming the replied user twice is not refused", () => {
    const rival = { id: 5150, is_bot: false, first_name: "Ana", username: "Rival" };
    expect(
      namedReplyRefusal({ text: "/cf 5 @rival @RIVAL", ...reply({ from: rival }) }, CREATOR),
    ).toBeNull();
  });

  test("a reply naming the replied user is not refused", () => {
    const rival = { id: 5150, is_bot: false, first_name: "Ana", username: "Rival" };
    expect(
      namedReplyRefusal({ text: "/cf 5 SOL @rival", ...reply({ from: rival }) }, CREATOR),
    ).toBeNull();
    expect(
      namedReplyRefusal(
        {
          text: "/cf 5 Ana",
          entities: [
            { type: "text_mention", offset: 6, length: 3, user: { ...rival, username: undefined } },
          ],
          ...reply({ from: rival }),
        } as any,
        CREATOR,
      ),
    ).toBeNull();
    // Without a username on the replied user, a typed name cannot be matched.
    expect(
      namedReplyRefusal(
        { text: "/cf 5 SOL @rival", ...reply({ from: { ...rival, username: undefined } }) },
        CREATOR,
      ),
    ).toBe("To challenge someone, reply to their message or name them without replying.");
  });

  test("a reply without a name is not refused", () => {
    expect(
      namedReplyRefusal(
        { text: "/cf 5 SOL", ...reply({ from: { id: 5150, is_bot: false, first_name: "Ana" } }) },
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

  test("a name among several that cannot be challenged is never told to reply", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const several = (
        ctx: any,
        overrides: Record<string, unknown>,
        found: string | null | Error,
      ) => resolveNamedChallenge(ctx, named(overrides), CREATOR, users(found), true);

      expect(await several(member(), { username: "@gh<o>st" }, null)).toEqual({
        refusal:
          "I don't know who <code>@gh&lt;o&gt;st</code> is yet. Ask them to use the bot here, then try again.",
      });
      expect(await several(member(), { username: "@a&b" }, new Error("synthetic-db-down"))).toEqual(
        { refusal: "I couldn't look up <code>@a&amp;b</code>. Try again." },
      );
      expect(await several(member(), {}, "synthetic-id")).toEqual({
        refusal:
          "I couldn't tell who one of them is. Ask them to use the bot here, then try again.",
      });
      expect(
        await several(telegramError(400, "Bad Request: user not found") as any, {}, "5150"),
      ).toEqual({
        refusal:
          "I couldn't verify <code>@rival</code>. Ask them to use the bot here, then try again.",
      });
      // Refusals that have nothing to do with replying read the same.
      expect(await several(member(), {}, String(CREATOR))).toEqual({
        refusal: "You can't challenge yourself.",
      });
      expect(await several(member({ ...RIVAL, is_bot: true }), {}, "5150")).toEqual({
        refusal: "You can't challenge a bot.",
      });
      expect(await several(member(), {}, "5150")).toEqual({
        challenge: { telegramId: "5150", displayName: "@Rival" },
      });
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

describe("resolveNamedChallenges", () => {
  const PEOPLE = [
    { id: 5150, is_bot: false, first_name: "Ana", username: "rival" },
    { id: 6160, is_bot: false, first_name: "Bo", username: "bo" },
    { id: 7171, is_bot: false, first_name: "Cid", username: "cid" },
  ];
  /** Telegram answering getChatMember for each of PEOPLE. */
  const group = () =>
    ({
      chat: { id: -100 },
      api: {
        getChatMember: async (_chatId: number, userId: number) => ({
          status: "member",
          user: PEOPLE.find((person) => person.id === userId),
        }),
      },
    }) as any;
  const directory = () => {
    const lookups: string[] = [];
    return {
      lookups,
      findTelegramIdByUsername: (username: string) => {
        lookups.push(username);
        const found = PEOPLE.find((person) => `@${person.username}` === username.toLowerCase());
        return found ? String(found.id) : null;
      },
    };
  };
  const names = (text: string) => findNamedUsers({ text } as any)!;

  test("everyone named is challenged, in the order named", async () => {
    const users = directory();

    expect(
      await resolveNamedChallenges(group(), names("/cf 5 @cid @rival @bo"), CREATOR, users, 3),
    ).toEqual({
      challenge: [
        { telegramId: "7171", displayName: "@cid" },
        { telegramId: "5150", displayName: "@rival" },
        { telegramId: "6160", displayName: "@bo" },
      ],
    });
    expect(users.lookups).toEqual(["@cid", "@rival", "@bo"]);
  });

  test("the first name that cannot be challenged refuses everyone, without looking up the rest", async () => {
    const users = directory();

    expect(
      await resolveNamedChallenges(group(), names("/cf 5 @rival @ghost @bo"), CREATOR, users, 3),
    ).toEqual({
      refusal:
        "I don't know who <code>@ghost</code> is yet. Ask them to use the bot here, then try again.",
    });
    expect(users.lookups).toEqual(["@rival", "@ghost"]);
  });

  test("a name typed twice is looked up and counted once", async () => {
    const users = directory();

    expect(
      await resolveNamedChallenges(group(), names("/cf 5 @rival @bo @Rival"), CREATOR, users, 2),
    ).toEqual({
      challenge: [
        { telegramId: "5150", displayName: "@rival" },
        { telegramId: "6160", displayName: "@bo" },
      ],
    });
    expect(users.lookups).toEqual(["@rival", "@bo"]);
  });

  test("someone both picked and typed is challenged once", async () => {
    const picked = findNamedUsers({
      text: "/cf 5 Ana @rival",
      entities: [{ type: "text_mention", offset: 6, length: 3, user: PEOPLE[0] }],
    } as any)!;

    expect(await resolveNamedChallenges(group(), picked, CREATOR, directory(), 2)).toEqual({
      challenge: [{ telegramId: "5150", displayName: "@rival" }],
    });
  });

  test("a single name that cannot be challenged is still told to reply", async () => {
    expect(
      await resolveNamedChallenges(group(), names("/cf 5 @ghost @Ghost"), CREATOR, directory(), 3),
    ).toEqual({
      refusal:
        "I don't know who <code>@ghost</code> is. Reply to one of their messages to challenge them.",
    });
  });

  test("someone picked and typed counts once against the seats, before any lookup", async () => {
    const users = directory();
    const picked = findNamedUsers({
      text: "/cf 5 Ana @Rival @bo",
      entities: [{ type: "text_mention", offset: 6, length: 3, user: PEOPLE[0] }],
    } as any)!;

    expect(await resolveNamedChallenges(group(), picked, CREATOR, users, 2)).toEqual({
      challenge: [
        { telegramId: "5150", displayName: "@rival" },
        { telegramId: "6160", displayName: "@bo" },
      ],
    });
    expect(users.lookups).toEqual(["@bo"]);
  });

  test("people picked without a username are told apart by their account", async () => {
    const ana = { id: 8181, is_bot: false, first_name: "Ana" };
    const bo = { id: 9191, is_bot: false, first_name: "Bo" };
    const picked = findNamedUsers({
      text: "/cf 5 Ana Bo",
      entities: [
        { type: "text_mention", offset: 6, length: 3, user: ana },
        { type: "text_mention", offset: 10, length: 2, user: bo },
      ],
    } as any)!;
    const ctx = {
      chat: { id: -100 },
      api: {
        getChatMember: async (_chatId: number, userId: number) => ({
          status: "member",
          user: [ana, bo].find((person) => person.id === userId),
        }),
      },
    } as any;

    expect(await resolveNamedChallenges(ctx, picked, CREATOR, directory(), 2)).toEqual({
      challenge: [
        { telegramId: "8181", displayName: "Ana" },
        { telegramId: "9191", displayName: "Bo" },
      ],
    });
    expect(await resolveNamedChallenges(ctx, picked, CREATOR, directory(), 1)).toEqual({
      refusal: "You can challenge up to 1 person at once.",
    });
  });

  test("more names than the game seats are refused before anyone is looked up", async () => {
    for (const [maxChallenged, answer] of [
      [2, "You can challenge up to 2 people at once."],
      [1, "You can challenge up to 1 person at once."],
    ] as const) {
      const users = directory();

      expect(
        await resolveNamedChallenges(
          group(),
          names("/cf 5 @rival @bo @cid"),
          CREATOR,
          users,
          maxChallenged,
        ),
      ).toEqual({ refusal: answer });
      expect(users.lookups).toEqual([]);
    }
  });

  test("as many names as the game seats are all challenged", async () => {
    const result = await resolveNamedChallenges(
      group(),
      names("/cf 5 @rival @bo"),
      CREATOR,
      directory(),
      2,
    );

    expect(result).toEqual({
      challenge: [
        { telegramId: "5150", displayName: "@rival" },
        { telegramId: "6160", displayName: "@bo" },
      ],
    });
  });
});
