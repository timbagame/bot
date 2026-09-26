import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { TOKEN_PROGRAM_ID } from "#token";
import { GameManager } from "../src/utils/game";
import {
  makeCtxStub,
  makeDbStub,
  makeProgramStub,
  makeWalletStub,
  resetGameManager,
} from "./helpers/game-manager";

const GAME_ADDRESS = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();

const buildJoinFixture = async (options: { postJoinFetchFails?: boolean } = {}) => {
  resetGameManager();
  const playerKp = await Keypair.generate();
  const tokenMint = new PublicKey("So11111111111111111111111111111111111111112");
  let fetchCount = 0;
  const preJoinAccount = {
    isPrivate: false,
    ticketsCount: 0,
    maxTickets: 2,
    gameType: { coinflip: {} },
    ticketAmount: 1_000,
    tokenMint,
    participants: [],
  };
  const postJoinAccount = { ...preJoinAccount, ticketsCount: 1 };
  const program = {
    programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
    account: {
      game: {
        fetch: async () => {
          fetchCount += 1;
          if (options.postJoinFetchFails) throw new Error("rpc down");
          return postJoinAccount;
        },
        fetchNullable: async () => {
          fetchCount += 1;
          return preJoinAccount;
        },
      },
    },
    methods: {
      joinGame: () => ({ accounts: () => ({ instruction: async () => ({}) }) }),
    },
  } as any;

  // Record when each pre-flight read starts and finishes to prove they overlap.
  const events: string[] = [];
  const tracked =
    <T>(name: string, value: T) =>
    async () => {
      events.push(`start:${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${name}`);
      return value;
    };
  const wallet = {
    getKeyPair: async () => playerKp,
    getTokenMetadata: tracked("metadata", { decimals: 9 }),
    getTokenBalance: tracked("token", 5_000),
    getBalance: tracked("sol", 5_000_000_000),
    sendTransaction: async () => "SIG",
  } as any;
  const feeBudget = { getGameSafetyBufferLamports: tracked("buffer", 1_000) };
  const gameDb = {
    getGame: () => ({ status: "active", token_mint: "M", token_ticker: "TOK" }),
    savePlayerMapping: () => {},
    saveGameParticipant: () => {},
    removeGameParticipant: () => {},
    getGameParticipants: () => [],
    getPlayerTelegramId: () => null,
  } as any;

  const gm = GameManager.getInstance(program, wallet, gameDb);
  (gm as any).feeBudget = feeBudget;
  (gm as any).oracleClient = { requestGameCompletion: async () => {} };
  (gm as any).confirmTransactionWithRecovery = async () => "SIG";
  const probes: any[][] = [];
  (gm as any).isPlayerInGame = async (...args: any[]) => {
    probes.push(args);
    return probes.length > 1;
  };
  (gm as any).resolveGameVaultAccounts = async () => ({
    tokenProgram: TOKEN_PROGRAM_ID,
    gameVault: playerKp.publicKey,
    gameVaultTokenAccount: playerKp.publicKey,
  });
  (gm as any).deriveAta = async () => playerKp.publicKey;
  let invalidated = 0;
  const originalInvalidate = gm.invalidatePublicGamesCache.bind(gm);
  gm.invalidatePublicGamesCache = () => {
    invalidated += 1;
    originalInvalidate();
  };

  return {
    gm,
    events,
    probes,
    preJoinAccount,
    postJoinAccount,
    getFetchCount: () => fetchCount,
    getInvalidated: () => invalidated,
  };
};

describe("GameManager.joinGame fetch reuse", () => {
  test("reuses the fetched account, overlaps pre-flight reads and returns the new account", async () => {
    const fixture = await buildJoinFixture();

    const result = await fixture.gm.joinGame(GAME_ADDRESS, 1n);

    expect(result).toMatchObject({
      success: true,
      ticketsCount: 1,
      maxTickets: 2,
      gameAccount: fixture.postJoinAccount,
    });
    // The duplicate check is handed the account from the initial fetch.
    expect(fixture.probes[0]![2]).toBe(fixture.preJoinAccount);
    // All four reads start before any finishes.
    expect(fixture.events.slice(0, 4).every((event) => event.startsWith("start:"))).toBe(true);
    // One pre-join fetch and one post-join fetch.
    expect(fixture.getFetchCount()).toBe(2);
    expect(fixture.getInvalidated()).toBe(1);
  });

  test("still succeeds without an account when the post-join read fails", async () => {
    const fixture = await buildJoinFixture({ postJoinFetchFails: true });
    const result = await fixture.gm.joinGame(GAME_ADDRESS, 1n);
    expect(result).toEqual({ success: true });
  });
});

describe("GameManager.isPlayerInGame with a known account", () => {
  test("uses the provided account instead of fetching", async () => {
    resetGameManager();
    const player = (await Keypair.generate()).publicKey;
    let fetched = 0;
    const gm = GameManager.getInstance(
      {
        account: {
          game: {
            fetchNullable: async () => {
              fetched += 1;
              return null;
            },
          },
        },
      } as any,
      {} as any,
      { getPlayerTelegramId: () => null } as any,
    );
    const pda = new PublicKey(GAME_ADDRESS);
    const isInGame = (account?: any) =>
      (gm as any).isPlayerInGame(pda, player, account) as Promise<boolean>;

    expect(await isInGame({ participants: [player] })).toBe(true);
    expect(await isInGame({ participants: [] })).toBe(false);
    expect(await isInGame(null)).toBe(false);
    expect(fetched).toBe(0);
    expect(await isInGame()).toBe(false);
    expect(fetched).toBe(1);
  });
});

describe("GameManager.updateGameMessage fan-out", () => {
  const seedChats = (gm: GameManager, chatIds: number[]) => {
    const map = new Map();
    for (const chatId of chatIds) {
      map.set(chatId, { chatId, messageId: chatId * 10, usesVideo: false });
    }
    (gm as any).activeGameMessages.set(GAME_ADDRESS, map);
  };

  test("edits chats in parallel and formats from the provided account", async () => {
    resetGameManager();
    let accountFetches = 0;
    const program = makeProgramStub({});
    program.account.game.fetch = async () => {
      accountFetches += 1;
      return {};
    };
    const gm = GameManager.getInstance(
      program,
      makeWalletStub(),
      makeDbStub({ gameOverride: { amount: 1_000, status: "active" } }),
    );
    seedChats(gm, [1, 2, 3, 4, 5, 6]);

    let inFlight = 0;
    let maxInFlight = 0;
    const edited: number[] = [];
    const ctx = makeCtxStub({
      apiOverrides: {
        editMessageText: async (chatId: number) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          edited.push(chatId);
          return true;
        },
      },
    });

    const gameAccount = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 2,
      createdAt: Math.floor(Date.now() / 1000),
      timeout: 600,
      gameType: { coinflip: {} },
      tokenMint: new PublicKey("So11111111111111111111111111111111111111112"),
      participants: [],
    };
    await gm.updateGameMessageFromData(
      ctx,
      GAME_ADDRESS,
      "Active",
      undefined,
      undefined,
      undefined,
      {
        gameAccount,
      },
    );

    expect(edited.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(accountFetches).toBe(0);
  });

  test("switches every chat to the completed view when completion lands mid-update", async () => {
    resetGameManager();
    let completed = false;
    const db = makeDbStub({
      extra: {
        getGame: () =>
          completed
            ? {
                token_mint: "MINT",
                token_ticker: "TOK",
                game_type: "coinflip",
                status: "completed",
                winner_address: "cancelled",
              }
            : { token_mint: "MINT", token_ticker: "TOK", game_type: "coinflip", status: "active" },
      },
    });
    const gm = GameManager.getInstance(
      makeProgramStub({
        ticketsCount: 1,
        maxTickets: 2,
        createdAt: Math.floor(Date.now() / 1000),
        timeout: 600,
        gameType: { coinflip: {} },
      }),
      makeWalletStub(),
      db,
    );
    seedChats(gm, [1, 2, 3]);
    const texts: string[] = [];
    const ctx = makeCtxStub({
      apiOverrides: {
        editMessageText: async (_chatId: number, _messageId: number, text: string) => {
          texts.push(text);
          completed = true;
          return true;
        },
      },
    });

    await gm.updateGameMessage(ctx, GAME_ADDRESS, "coinflip", 1_000, "@creator", "Active", "TOK");

    expect(texts.some((text) => text.includes("Cancelled"))).toBe(true);
  });
});
