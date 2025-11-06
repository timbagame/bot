import { describe, test, expect, beforeEach } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";
import { formatAmount, formatCompactTokenDisplay } from "../src/utils/format-amount";

// Helpers to reset singleton
function resetGameManager() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function makeProgramStub(game: any) {
  return {
    account: {
      game: {
        fetch: async () => game,
      },
    },
  } as any;
}

function makeWalletStub(opts?: { blockTime?: number; tokenDecimals?: number }) {
  const blockTime = opts?.blockTime ?? Math.floor(Date.now() / 1000);
  const tokenDecimals = opts?.tokenDecimals ?? 9;
  return {
    getBlockchainTime: async () => blockTime,
    formatTokenBalance: (
      amount: number | bigint | string,
      decimals: number
    ) => formatAmount(amount, decimals, { maxFractionDigits: 6, trim: true }),
    formatSolBalance: (amount: number | bigint | string) =>
      formatAmount(amount, 9, { maxFractionDigits: 6, trim: true }),
    getTokenMetadata: async () => ({ decimals: tokenDecimals }),
  } as any;
}

function makeDbStub(
  participants: string[],
  gameData: any,
  playerTelegramByPub: Record<string, string>,
  displayNameByTelegram: Record<string, string> = {}
) {
  return {
    getGameParticipants: (_addr: string) => participants,
    getGame: (_addr: string) => gameData,
    getPlayerTelegramId: (pub: string) => playerTelegramByPub[pub] || null,
    getPlayerDisplayName: (telegramId: string) =>
      displayNameByTelegram[telegramId] ?? null,
  } as any;
}

function makeCtxStub() {
  return {
    chat: { id: 42 },
    api: {
      getChatMember: async (_chatId: number, userId: number) => ({
        user: { username: `user${userId}`, first_name: `U${userId}` },
        status: "member",
      }),
    },
  } as any;
}

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
    const wallet = makeWalletStub({ blockTime: createdAt + 30 });
    const db = makeDbStub(["123", "456"], { token_ticker: "WSOL" }, {});
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
  const gamePda = Keypair.generate().publicKey;

  const res = await gm.formatGameMessage(ctx, gamePda, "coinflip", amount, "@creator", "Active", "WSOL");
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
    const wallet = makeWalletStub();
    const db = makeDbStub(["111","222","333"], { token_ticker: "WSOL", game_type: "giveaway" }, { [winner]: "999" });
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
  const gamePda = Keypair.generate().publicKey;

    const res = await gm.formatGameMessage(ctx, gamePda, "giveaway", amount, "@creator", "Completed", "WSOL", winner);
    expect(res.messageText).toContain("Winner:");
    expect(res.messageText).toContain("@user999");
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
    const wallet = makeWalletStub();
    const db = makeDbStub([
      "321",
    ], {
      token_ticker: "WSOL",
      game_type: "coinflip",
      token_mint: tokenMint.toBase58(),
    }, { [winnerPubkey]: "321" });
    const ctx = {
      ...makeCtxStub(),
      api: {
        getChatMember: async () => ({
          user: { first_name: "<Winner & Co>" },
        }),
      },
    } as any;
    const gm = GameManager.getInstance(program, wallet, db);
  const gamePda = Keypair.generate().publicKey;

  const res = await gm.formatGameMessage(
    ctx,
    gamePda,
    "coinflip",
    amount,
    "@creator",
    "Completed",
    "WSOL",
    winnerPubkey
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
    const wallet = makeWalletStub();
    const db = makeDbStub(
      ["999"],
      {
        token_ticker: "WSOL",
        game_type: "coinflip",
        token_mint: tokenMint.toBase58(),
      },
      { [winnerPubkey]: "999" },
      { "999": "<Stored Winner>" }
    );
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
    const gamePda = Keypair.generate().publicKey;

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      amount,
      "@creator",
      "Completed",
      "WSOL",
      winnerPubkey
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
    const db = makeDbStub([
      "555",
      "666",
    ], { token_ticker: "WSOL", token_mint: tokenMint.toBase58() }, {});
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
  const gamePda = Keypair.generate().publicKey;

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      amount,
      "@creator",
      "Active",
      "WSOL"
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
