import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";
import { DEFAULT_NULL_ADDRESS } from "../src/utils/constants";
import { formatAmount, formatCompactTokenDisplay } from "../src/utils/format-amount";
import { sanitizeTelegramDisplayName } from "../src/utils/telegram-display";
import {
  makeCtxStub,
  makeDbStub,
  makeProgramStub,
  makeWalletStub,
  randomGamePublicKey,
  resetGameManager,
} from "./helpers/game-manager";

describe("GameManager.formatGameMessage", () => {
  beforeEach(resetGameManager);

  test("coinflip active: shows prize = amount * tickets and participants", async () => {
    const amount = 1_000_000_000; // 1 token with 9 decimals
    const createdAt = 1_000_000;
    const timeout = 60;
    const gameAccount = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 2,
      totalAmount: 0,
      createdAt,
      timeout,
    };
    const program = makeProgramStub(gameAccount);
    const wallet = makeWalletStub({
      blockTime: createdAt + 30,
      tokenFormatter: (amount, decimals) =>
        formatAmount(amount, decimals, { maxFractionDigits: 6, trim: true }),
    });
    const db = makeDbStub({
      participants: ["123", "456"],
      gameOverride: { token_ticker: "WSOL" },
    });
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
    const gamePda = await randomGamePublicKey();

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      amount,
      "@creator",
      "Active",
      "WSOL",
    );
    expect(res.messageText).toContain("WSOL");
    // Message formatting basics
    // Status present
    expect(res.messageText).toContain("Status:");
    // Keyboard shows Join/Refresh
    expect((res.keyboard[0] || []).length).toBeGreaterThan(0);
    expect(res.messageText).not.toContain("@@user");
    expect(res.messageText).not.toContain("@@");
  });

  test("giveaway completed: shows winner line and no keyboard", async () => {
    const amount = 1_000_000_000; // 1 token with 9 decimals
    const createdAt = 1_000_000;
    const timeout = 60;
    const gameAccount = {
      ticketsCount: 3,
      maxTickets: 5,
      minTickets: 1,
      totalAmount: 0,
      createdAt,
      timeout,
      gameType: { giveaway: {} },
    };
    const winner = "WINNERPUB";
    const program = makeProgramStub(gameAccount);
    const wallet = makeWalletStub({
      tokenFormatter: (amount, decimals) =>
        formatAmount(amount, decimals, { maxFractionDigits: 6, trim: true }),
    });
    const db = makeDbStub({
      participants: ["111", "222", "333"],
      gameOverride: { token_ticker: "WSOL", game_type: "giveaway" },
      playerTelegramByPub: { [winner]: "999" },
    });
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
    const gamePda = await randomGamePublicKey();

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "giveaway",
      amount,
      "@creator",
      "Completed",
      "WSOL",
      winner,
    );
    expect(res.messageText).toContain("Winner:");
    expect(res.messageText).toContain(sanitizeTelegramDisplayName("@user999"));
    // No keyboard for completed
    expect(res.keyboard.length).toBe(0);
  });

  test("winner display escapes HTML-sensitive characters", async () => {
    const amount = 500_000_000; // 0.5 token with 9 decimals
    const tokenMint = {
      toBase58: () => "TokenMint11111111111111111111111111111111",
    } as unknown as PublicKey;
    const gameAccount = {
      ticketsCount: 1,
      maxTickets: 1,
      minTickets: 1,
      totalAmount: null,
      createdAt: 1_000_000,
      timeout: 120,
      gameType: { coinflip: {} },
      tokenMint,
    };
    const winnerPubkey = "WinnerPubkey";
    const program = makeProgramStub(gameAccount);
    const wallet = makeWalletStub({
      tokenFormatter: (amount, decimals) =>
        formatAmount(amount, decimals, { maxFractionDigits: 6, trim: true }),
    });
    const db = makeDbStub({
      participants: ["321"],
      gameOverride: {
        token_ticker: "WSOL",
        game_type: "coinflip",
        token_mint: tokenMint.toBase58(),
      },
      playerTelegramByPub: { [winnerPubkey]: "321" },
    });
    const ctx = {
      ...makeCtxStub(),
      api: {
        getChatMember: async () => ({
          user: { first_name: "<Winner & Co>" },
        }),
      },
    } as any;
    const gm = GameManager.getInstance(program, wallet, db);
    const gamePda = await randomGamePublicKey();

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      amount,
      "@creator",
      "Completed",
      "WSOL",
      winnerPubkey,
    );

    expect(res.messageText).toContain("Winner: &lt;Winner &amp; Co&gt;");
  });

  test("falls back to stored display name and escapes HTML when Telegram lookup fails", async () => {
    resetGameManager();
    const amount = 1_000_000_000;
    const tokenMint = {
      toBase58: () => "TokenMint33333333333333333333333333333333",
    } as unknown as PublicKey;
    const gameAccount = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: null,
      createdAt: 1_500_000,
      timeout: 120,
      gameType: { coinflip: {} },
      tokenMint,
    };
    const winnerPubkey = "WinnerPubkey";
    const program = makeProgramStub(gameAccount);
    const wallet = makeWalletStub({
      tokenFormatter: (amount, decimals) =>
        formatAmount(amount, decimals, { maxFractionDigits: 6, trim: true }),
    });
    const db = makeDbStub({
      participants: ["999"],
      gameOverride: {
        token_ticker: "WSOL",
        game_type: "coinflip",
        token_mint: tokenMint.toBase58(),
      },
      playerTelegramByPub: { [winnerPubkey]: "999" },
      displayNameByTelegram: { "999": "<Stored Winner>" },
    });
    const ctx = {
      ...makeCtxStub(),
      api: {
        getChatMember: async () => {
          throw Object.assign(new Error("Forbidden"), {
            description: "Forbidden: bot can't initiate conversation with a user",
          });
        },
      },
    } as any;
    const gm = GameManager.getInstance(program, wallet, db);
    const gamePda = await randomGamePublicKey();

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      amount,
      "@creator",
      "Completed",
      "WSOL",
      winnerPubkey,
    );

    expect(res.messageText).toContain("Winner: &lt;Stored Winner&gt;");
  });

  test("supports bigint ticket amounts without USD approximations", async () => {
    const amount = BigInt(Number.MAX_SAFE_INTEGER) + 5000n;
    const tokenMint = {
      toBase58: () => "TokenMint22222222222222222222222222222222",
    } as unknown as PublicKey;
    const gameAccount = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 2,
      totalAmount: null,
      createdAt: 2_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
      tokenMint,
    };
    const program = makeProgramStub(gameAccount);
    const wallet = makeWalletStub();
    const db = makeDbStub({
      participants: ["555", "666"],
      gameOverride: {
        token_ticker: "WSOL",
        token_mint: tokenMint.toBase58(),
      },
    });
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
    const gamePda = await randomGamePublicKey();

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      amount,
      "@creator",
      "Active",
      "WSOL",
    );

    const expectedTicket = formatAmount(amount, 9, {
      maxFractionDigits: 6,
      trim: true,
    });
    const expectedCompact = formatCompactTokenDisplay(expectedTicket);
    expect(res.messageText).toContain(`${expectedCompact} WSOL`);
    expect(res.messageText).not.toContain("$");
  });
});

describe("GameManager.formatGameMessage for a challenge", () => {
  beforeEach(resetGameManager);

  const CHALLENGE = [{ telegramId: "5150", displayName: "@rival" }];
  // Inserted after "@" so a name stays readable without pinging anyone.
  const WORD_JOINER = String.fromCharCode(0x2060);
  const render = async (options: {
    ticketsCount: number;
    seats?: number;
    /** The wallets on chain, each known as the Telegram id it maps to. */
    onChainPlayers?: Record<string, string>;
    status?: string;
    winner?: string;
    participants?: string[];
    suppressMentions?: boolean;
    getGameChallenge?: (address: string) => unknown;
    getPlayerTelegramId?: (publicKey: string) => string | null;
  }) => {
    const createdAt = 1_000_000;
    const program = makeProgramStub({
      ticketsCount: options.ticketsCount,
      maxTickets: options.seats ?? 2,
      minTickets: options.seats ?? 2,
      totalAmount: 0,
      createdAt,
      timeout: 600,
      gameType: { coinflip: {} },
      ...(options.onChainPlayers ? { participants: Object.keys(options.onChainPlayers) } : {}),
    });
    const wallet = makeWalletStub({
      blockTime: createdAt + 30,
      tokenFormatter: (amount, decimals) =>
        formatAmount(amount, decimals, { maxFractionDigits: 6, trim: true }),
    });
    const db = makeDbStub({
      participants: options.participants ?? ["4242", "5150"],
      gameOverride: { token_ticker: "WSOL" },
      playerTelegramByPub: { WINNERPUB: "5150", ...options.onChainPlayers },
      extra: {
        getGameChallenge: options.getGameChallenge ?? (() => CHALLENGE),
        ...(options.getPlayerTelegramId
          ? { getPlayerTelegramId: options.getPlayerTelegramId }
          : {}),
      },
    });
    const gm = GameManager.getInstance(program, wallet, db);
    const gamePda = await randomGamePublicKey();
    const res = await gm.formatGameMessage(
      makeCtxStub(),
      gamePda,
      "coinflip",
      1_000_000_000,
      "@creator",
      options.status ?? "Active",
      "WSOL",
      options.winner,
      undefined,
      undefined,
      options.suppressMentions ? { suppressMentions: true } : undefined,
    );
    return { ...res, gameAddress: gamePda.toBase58() };
  };

  test("an open challenge names and mentions the challenged player, with an Accept button", async () => {
    const res = await render({ ticketsCount: 1 });

    expect(res.messageText).toContain("<b>⚔️ Challenge ");
    expect(res.messageText).toContain('@creator challenged <a href="tg://user?id=5150">@rival</a>');
    expect(res.messageText).toContain(`\nStatus: Waiting for @${WORD_JOINER}rival to accept`);
    expect(res.messageText).not.toContain("Creator:");
    expect(res.messageText).not.toContain("\n1. ");
    expect(res.keyboard).toEqual([
      [
        { text: "⚔️ Accept", callback_data: `join_${res.gameAddress}` },
        { text: "🔁 Refresh", callback_data: `refresh_${res.gameAddress}` },
      ],
    ]);
  });

  test("an accepted challenge shows the match and waits for the draw", async () => {
    const res = await render({ ticketsCount: 2 });

    expect(res.messageText).toContain('@creator vs <a href="tg://user?id=5150">@rival</a>');
    expect(res.messageText).toContain("\nStatus: Accepted, drawing soon");
    expect(res.messageText).not.toContain("challenged");
  });

  test("cards copied without mentions do not link or ping the challenged player", async () => {
    const res = await render({ ticketsCount: 1, suppressMentions: true });

    // Both names carry a word joiner after "@" so neither one pings.
    expect(res.messageText).toContain(`@${WORD_JOINER}creator challenged @${WORD_JOINER}rival`);
    expect(res.messageText).not.toContain("tg://user");
  });

  test("a finished challenge keeps the match header, names the winner and drops the buttons", async () => {
    const res = await render({ ticketsCount: 2, status: "Completed", winner: "WINNERPUB" });

    expect(res.messageText).toContain('@creator vs <a href="tg://user?id=5150">@rival</a>');
    expect(res.messageText).toContain("Winner:");
    expect(res.messageText).not.toContain("Status:");
    expect(res.keyboard).toEqual([]);
  });

  test.each(["cancelled", DEFAULT_NULL_ADDRESS])(
    "a challenge that expired unanswered never reads as a match (winner %s)",
    async (winner) => {
      const res = await render({
        ticketsCount: 1,
        status: "Completed",
        winner,
        participants: ["4242"],
      });

      expect(res.messageText).toContain(
        '@creator challenged <a href="tg://user?id=5150">@rival</a>',
      );
      expect(res.messageText).toContain("Status: Cancelled");
      expect(res.messageText).not.toContain(" vs ");
    },
  );

  test("a challenge that cannot be read renders as a regular coinflip", async () => {
    const res = await render({
      ticketsCount: 1,
      getGameChallenge: () => {
        throw new Error("synthetic-read-failure");
      },
    });

    expect(res.messageText).toContain("Creator: @creator • 1/2 players");
    expect(res.keyboard[0]?.[0]?.text).toBe("🎮 Join");
  });

  test("a coinflip without a challenge keeps the regular card", async () => {
    const res = await render({ ticketsCount: 1, getGameChallenge: () => [] });

    expect(res.messageText).toContain("Creator: @creator • 1/2 players");
    expect(res.messageText).toContain("\nStatus: ▰▱ Needs 1 more player to start");
    expect(res.messageText).not.toContain("⚔️");
    expect(res.keyboard[0]?.[0]?.text).toBe("🎮 Join");
  });

  test("a finished challenge reads as a match even when the local player list lags", async () => {
    const res = await render({
      ticketsCount: 2,
      status: "Completed",
      winner: "WINNERPUB",
      participants: ["4242"],
    });

    expect(res.messageText).toContain('@creator vs <a href="tg://user?id=5150">@rival</a>');
    expect(res.messageText).not.toContain("challenged");
  });

  test("the challenged player's name is escaped in every place it renders", async () => {
    const markup = [{ telegramId: "5150", displayName: "<b>Ana & Co</b>" }];
    const escaped = "&lt;b&gt;Ana &amp; Co&lt;/b&gt;";

    const open = await render({ ticketsCount: 1, getGameChallenge: () => markup });
    expect(open.messageText).toContain(`challenged <a href="tg://user?id=5150">${escaped}</a>`);
    expect(open.messageText).toContain(`\nStatus: Waiting for ${escaped} to accept`);
    expect(open.messageText).not.toContain("<b>Ana");

    const copied = await render({
      ticketsCount: 1,
      suppressMentions: true,
      getGameChallenge: () => markup,
    });
    expect(copied.messageText).toContain(`challenged ${escaped}`);
    expect(copied.messageText).not.toContain("<b>Ana");
  });

  const THREE = [
    { telegramId: "5150", displayName: "@rival" },
    { telegramId: "6160", displayName: "@bo" },
    { telegramId: "7171", displayName: "Cid" },
  ];
  const WALLET = {
    creator: "So11111111111111111111111111111111111111112",
    rival: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    bo: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    cid: "SysvarRent111111111111111111111111111111111",
  };
  const RIVAL_LINK = '<a href="tg://user?id=5150">@rival</a>';
  const BO_LINK = '<a href="tg://user?id=6160">@bo</a>';
  const CID_LINK = '<a href="tg://user?id=7171">Cid</a>';

  test("an open challenge to several people names them all and waits for whoever has not accepted", async () => {
    const res = await render({
      ticketsCount: 2,
      seats: 4,
      onChainPlayers: { [WALLET.creator]: "4242", [WALLET.bo]: "6160" },
      getGameChallenge: () => THREE,
    });

    expect(res.messageText).toContain(
      `\n@creator challenged ${RIVAL_LINK}, ${BO_LINK} and ${CID_LINK}\n`,
    );
    expect(res.messageText).toContain(
      `\nStatus: Waiting for @${WORD_JOINER}rival and Cid to accept`,
    );
    expect(res.keyboard[0]?.[0]).toEqual({
      text: "⚔️ Accept",
      callback_data: `join_${res.gameAddress}`,
    });
  });

  test("a wallet past the joined count is not taken for someone who accepted", async () => {
    const res = await render({
      ticketsCount: 2,
      seats: 4,
      onChainPlayers: { [WALLET.creator]: "4242", [WALLET.bo]: "6160", [WALLET.rival]: "5150" },
      getGameChallenge: () => THREE,
    });

    expect(res.messageText).toContain(
      `\nStatus: Waiting for @${WORD_JOINER}rival and Cid to accept`,
    );
  });

  test("a challenge everyone accepted lines them all up and waits for the draw", async () => {
    const res = await render({
      ticketsCount: 4,
      seats: 4,
      onChainPlayers: {
        [WALLET.creator]: "4242",
        [WALLET.rival]: "5150",
        [WALLET.bo]: "6160",
        [WALLET.cid]: "7171",
      },
      getGameChallenge: () => THREE,
    });

    expect(res.messageText).toContain(`\n@creator vs ${RIVAL_LINK} vs ${BO_LINK} vs ${CID_LINK}\n`);
    expect(res.messageText).toContain("\nStatus: Accepted, drawing soon");
    expect(res.messageText).not.toContain("challenged");
  });

  test("with no challenged player left to name, the card counts the seats instead", async () => {
    const res = await render({
      ticketsCount: 3,
      seats: 4,
      onChainPlayers: { [WALLET.rival]: "5150", [WALLET.bo]: "6160", [WALLET.cid]: "7171" },
      getGameChallenge: () => THREE,
    });

    expect(res.messageText).toContain(
      `\n@creator challenged ${RIVAL_LINK}, ${BO_LINK} and ${CID_LINK}\n`,
    );
    expect(res.messageText).toContain("\nStatus: ▰▰▰▱ Needs 1 more player to start");
  });

  test("a lone challenged player is named as waiting without reading who joined, as before", async () => {
    for (const onChainPlayers of [undefined, { [WALLET.creator]: "4242" }]) {
      const getPlayerTelegramId = mock((_publicKey: string): string | null => null);

      const res = await render({ ticketsCount: 1, onChainPlayers, getPlayerTelegramId });

      expect(res.messageText).toContain(`\nStatus: Waiting for @${WORD_JOINER}rival to accept`);
      expect(getPlayerTelegramId).not.toHaveBeenCalled();
    }
  });

  test("right after it opens, a challenge to several names everyone without reading who joined", async () => {
    const getPlayerTelegramId = mock((_publicKey: string): string | null => null);

    const res = await render({
      ticketsCount: 1,
      seats: 4,
      getGameChallenge: () => THREE,
      getPlayerTelegramId,
    });

    expect(res.messageText).toContain(
      `\nStatus: Waiting for @${WORD_JOINER}rival, @${WORD_JOINER}bo and Cid to accept`,
    );
    expect(getPlayerTelegramId).not.toHaveBeenCalled();
  });

  test("a player list behind the joined count never names someone who already accepted", async () => {
    const res = await render({
      ticketsCount: 3,
      seats: 4,
      onChainPlayers: { [WALLET.creator]: "4242", [WALLET.bo]: "6160" },
      getGameChallenge: () => THREE,
    });

    expect(res.messageText).toContain("\nStatus: ▰▰▰▱ Needs 1 more player to start");
    expect(res.messageText).not.toContain("Waiting for");
  });

  test("once someone accepted, without the joined wallets listed the card counts the seats instead", async () => {
    const res = await render({ ticketsCount: 2, seats: 4, getGameChallenge: () => THREE });

    expect(res.messageText).toContain("\nStatus: ▰▰▱▱ Needs 2 more players to start");
    expect(res.messageText).not.toContain("Waiting for");
  });

  test("when who accepted cannot be read, the card counts the seats instead", async () => {
    const failure = new Error("synthetic-read-failure");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await render({
        ticketsCount: 2,
        seats: 4,
        onChainPlayers: { [WALLET.creator]: "4242", [WALLET.bo]: "6160" },
        getGameChallenge: () => THREE,
        getPlayerTelegramId: () => {
          throw failure;
        },
      });

      expect(res.messageText).toContain("\nStatus: ▰▰▱▱ Needs 2 more players to start");
      expect(warn).toHaveBeenCalledWith("Failed to read who accepted a challenge:", failure);
    } finally {
      warn.mockRestore();
    }
  });
});
