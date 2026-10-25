import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";
import { stubInstantTimers } from "./helpers/timers";

const GAME_PDA = new PublicKey("BPFLoader1111111111111111111111111111111111");
const GAME_ADDRESS = GAME_PDA.toBase58();

const makeManager = (program: any = { account: { game: {} } }, gameDb: any = {}): any =>
  GameManager.getInstance(program, {} as any, gameDb) as any;

const freshKey = async () => (await Keypair.generate()).publicKey;

describe("GameManager coverage-a: isPlayerInGame", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  test("warns and still checks the chain when the local participant lookup throws", async () => {
    const player = await freshKey();
    const failure = new Error("sqlite busy");
    const gm = makeManager(
      { account: { game: { fetchNullable: async () => ({ participants: [player] }) } } },
      {
        getPlayerTelegramId: () => {
          throw failure;
        },
      },
    );

    expect(await gm.isPlayerInGame(GAME_PDA, player)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Failed to check local participant records for ${GAME_ADDRESS}:`,
      failure,
    );
  });

  test("uses the legacy fetch method when fetchNullable is not available", async () => {
    const player = await freshKey();
    let fetched: PublicKey | undefined;
    const gm = makeManager(
      {
        account: {
          game: {
            fetch: async (address: PublicKey) => {
              fetched = address;
              return { participants: [player] };
            },
          },
        },
      },
      { getPlayerTelegramId: () => null },
    );

    expect(await gm.isPlayerInGame(GAME_PDA, player)).toBe(true);
    expect(fetched?.toBase58()).toBe(GAME_ADDRESS);
  });

  test("skips unparseable on-chain participants instead of failing", async () => {
    const player = await freshKey();
    const gm = makeManager(
      {
        account: { game: { fetchNullable: async () => ({ participants: ["not-a-key", player] }) } },
      },
      { getPlayerTelegramId: () => null },
    );

    expect(await gm.isPlayerInGame(GAME_PDA, player)).toBe(true);

    const other = makeManager(
      { account: { game: { fetchNullable: async () => ({ participants: ["not-a-key"] }) } } },
      { getPlayerTelegramId: () => null },
    );
    expect(await other.isPlayerInGame(GAME_PDA, player)).toBe(false);
  });

  test("returns false and warns when the on-chain read fails", async () => {
    const failure = new Error("rpc down");
    const gm = makeManager(
      {
        account: {
          game: {
            fetchNullable: async () => {
              throw failure;
            },
          },
        },
      },
      { getPlayerTelegramId: () => null },
    );

    expect(await gm.isPlayerInGame(GAME_PDA, await freshKey())).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Failed to verify on-chain participants for ${GAME_ADDRESS}:`,
      failure,
    );
  });
});

describe("GameManager coverage-a: verifyParticipantJoin retries", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let timers: ReturnType<typeof stubInstantTimers>;

  beforeEach(() => {
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    timers = stubInstantTimers();
  });
  afterEach(() => {
    timers.restore();
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  test("waits with a growing delay between attempts and gives up with a warning", async () => {
    const player = await freshKey();
    const saved: unknown[][] = [];
    const gm = makeManager(
      { account: { game: { fetchNullable: async () => ({ participants: [] }) } } },
      {
        getPlayerTelegramId: () => null,
        saveGameParticipant: (...args: unknown[]) => saved.push(args),
      },
    );

    const verified = await gm.verifyParticipantJoin(GAME_PDA, player, "5", { maxAttempts: 3 });

    expect(verified).toBe(false);
    expect(timers.delays).toEqual([500, 1_000]);
    expect(saved).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Player ${player.toBase58()} not yet recorded on-chain for ${GAME_ADDRESS} after 3 verification attempt(s)`,
    );
  });

  test("records the participant once a later attempt sees them on chain", async () => {
    const player = await freshKey();
    let reads = 0;
    const saved: unknown[][] = [];
    const gm = makeManager(
      {
        account: {
          game: {
            fetchNullable: async () => {
              reads += 1;
              return { participants: reads >= 2 ? [player] : [] };
            },
          },
        },
      },
      {
        getPlayerTelegramId: () => null,
        saveGameParticipant: (...args: unknown[]) => saved.push(args),
      },
    );

    expect(await gm.verifyParticipantJoin(GAME_PDA, player, "5", { joinSignature: "SIG" })).toBe(
      true,
    );
    expect(timers.delays).toEqual([500]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.slice(0, 3)).toEqual([GAME_ADDRESS, "5", player.toBase58()]);
    expect(saved[0]?.[3]).toMatchObject({ status: "confirmed", joinSignature: "SIG" });
  });
});

describe("GameManager coverage-a: reconcilePendingParticipants", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  test("does nothing when the database has no pending participant support or no pending rows", async () => {
    const noSupport = makeManager();
    await noSupport.reconcilePendingParticipants(GAME_PDA);

    GameManager.resetForTest();
    const emptyDb = makeManager(undefined, { getPendingParticipants: () => [] });
    await emptyDb.reconcilePendingParticipants(GAME_PDA);

    GameManager.resetForTest();
    const notAnArray = makeManager(undefined, { getPendingParticipants: () => null });
    await notAnArray.reconcilePendingParticipants(GAME_PDA);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("skips rows it cannot identify and removes only stale unverified participants", async () => {
    const stalePlayer = await freshKey();
    const freshPlayer = await freshKey();
    const lookedUp = await freshKey();
    const removed: Array<[string, string]> = [];
    const verifiedCalls: string[] = [];
    const now = Date.now();
    const gm = makeManager(undefined, {
      getPendingParticipants: () => [
        { public_key: stalePlayer.toBase58() },
        { telegram_id: "no-key" },
        { telegram_id: "bad-key", public_key: "definitely not base58 !!" },
        { telegramId: "looked-up" },
        { telegram_id: "stale", public_key: stalePlayer.toBase58(), joined_at: now - 10 * 60_000 },
        { telegram_id: "fresh", publicKey: freshPlayer.toBase58(), joinedAt: now - 1_000 },
        { telegram_id: "never-joined", public_key: freshPlayer.toBase58() },
      ],
      getPlayerPublicKey: (telegramId: string) =>
        telegramId === "looked-up" ? lookedUp.toBase58() : null,
      removeGameParticipant: (game: string, telegramId: string) => removed.push([game, telegramId]),
    });
    gm.verifyParticipantJoin = async (_pda: PublicKey, _key: PublicKey, telegramId: string) => {
      verifiedCalls.push(telegramId);
      return false;
    };

    await gm.reconcilePendingParticipants(GAME_PDA);

    expect(verifiedCalls).toEqual(["looked-up", "stale", "fresh", "never-joined"]);
    expect(removed).toEqual([[GAME_ADDRESS, "stale"]]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GameManager coverage-a: recoverParticipantsFromChain", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  test("returns nothing when the account has no usable participant list", async () => {
    const gm = makeManager();
    const empty = { recovered: [], unmatchedParticipants: [] };

    expect(gm.recoverParticipantsFromChain(GAME_PDA, {}, new Set())).toEqual(empty);
    expect(gm.recoverParticipantsFromChain(GAME_PDA, { participants: [] }, new Set())).toEqual(
      empty,
    );
    expect(
      gm.recoverParticipantsFromChain(GAME_PDA, { participants: ["not-a-key"] }, new Set()),
    ).toEqual(empty);
  });

  test("returns nothing when every on-chain participant is already known", async () => {
    const known = await freshKey();
    const gm = makeManager(undefined, { getPlayerPublicKey: () => known.toBase58() });

    const result = gm.recoverParticipantsFromChain(
      GAME_PDA,
      { participants: [known] },
      new Set(["10"]),
    );

    expect(result).toEqual({ recovered: [], unmatchedParticipants: [] });
  });

  test("ignores known ids without a stored key or with a corrupt key", async () => {
    const unknownPlayer = await freshKey();
    const gm = makeManager(undefined, {
      getPlayerPublicKey: (telegramId: string) => (telegramId === "10" ? null : "corrupt key"),
      getAllPlayerMappings: () => [],
    });

    const result = gm.recoverParticipantsFromChain(
      GAME_PDA,
      { participants: [unknownPlayer] },
      new Set(["10", "11"]),
    );

    expect(result.recovered).toEqual([]);
    expect(result.unmatchedParticipants).toEqual([unknownPlayer.toBase58()]);
    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Unable to match any on-chain participants for ${GAME_ADDRESS}`,
    );
  });

  test("recovers participants from stored mappings, skipping incomplete or corrupt ones", async () => {
    const recoverable = await freshKey();
    const stillMissing = await freshKey();
    const saved: unknown[][] = [];
    const known = new Set<string>();
    const gm = makeManager(undefined, {
      getPlayerPublicKey: () => null,
      getAllPlayerMappings: () => [
        { telegram_id: "", public_key: recoverable.toBase58() },
        { telegram_id: "20" },
        { telegram_id: "21", public_key: "corrupt key" },
        { telegramId: "22", publicKey: recoverable.toBase58() },
      ],
      saveGameParticipant: (...args: unknown[]) => saved.push(args),
    });

    const result = gm.recoverParticipantsFromChain(
      GAME_PDA,
      { participants: [recoverable, stillMissing] },
      known,
    );

    expect(result.recovered).toEqual([{ telegramId: "22", publicKey: recoverable.toBase58() }]);
    expect(result.unmatchedParticipants).toEqual([stillMissing.toBase58()]);
    expect(known.has("22")).toBe(true);
    expect(saved[0]?.slice(0, 3)).toEqual([GAME_ADDRESS, "22", recoverable.toBase58()]);
    expect(warnSpy).toHaveBeenCalledWith(`⚠️ Unable to map 1 participant(s) for ${GAME_ADDRESS}`);
  });

  test("keeps going and leaves the participant unknown when persisting a recovered one fails", async () => {
    const recoverable = await freshKey();
    const failure = new Error("disk full");
    const known = new Set<string>();
    const gm = makeManager(undefined, {
      getPlayerPublicKey: () => null,
      getAllPlayerMappings: () => [{ telegram_id: "30", public_key: recoverable.toBase58() }],
      saveGameParticipant: () => {
        throw failure;
      },
    });

    const result = gm.recoverParticipantsFromChain(
      GAME_PDA,
      { participants: [recoverable] },
      known,
    );

    expect(result.recovered).toHaveLength(1);
    expect(known.has("30")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Failed to persist recovered participant 30 for ${GAME_ADDRESS}:`,
      failure,
    );
  });
});
