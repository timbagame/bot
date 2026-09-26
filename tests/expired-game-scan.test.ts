import { describe, expect, test, vi } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { createExpiredGameScanner, type ExpiredGameScanDeps } from "../src/bot/expired-game-scan";
import { DEFAULT_NULL_ADDRESS } from "../src/utils/constants";
import { TimbaAccountNotFoundError } from "../src/utils/timba-program";

const address = async () => (await Keypair.generate()).publicKey.toBase58();
const game = (game_address: string) => ({ game_address }) as any;

const createDeps = (overrides: Partial<ExpiredGameScanDeps> = {}) => {
  const deps = {
    getGamesExpiringBefore: vi.fn((): any[] => []),
    gameAccounts: vi.fn(() => ({
      fetch: vi.fn(async () => ({ ticketsCount: 0, maxTickets: 2 })),
      fetchMultiple: vi.fn(async (keys: PublicKey[]) =>
        keys.map(() => ({ ticketsCount: 0, maxTickets: 2, expired: true })),
      ),
    })),
    getBlockchainTime: vi.fn(async () => 1_000),
    isExpired: vi.fn((account: any) => account.expired === true),
    handleExpiredGame: vi.fn(async () => ({ cancelled: true })),
    completeGame: vi.fn(),
    updateGameMessage: vi.fn(async () => {}),
    cleanupOrphanedGame: vi.fn(async () => {}),
    lookaheadMs: 60_000,
    now: () => 5_000,
    ...overrides,
  };
  return deps;
};

describe("createExpiredGameScanner", () => {
  test("reads blockchain time once and batch-loads accounts per scan", async () => {
    const addresses = await Promise.all(Array.from({ length: 3 }, address));
    const api = {
      fetch: vi.fn(),
      fetchMultiple: vi.fn(async (keys: PublicKey[]) =>
        keys.map((key) => ({
          ticketsCount: 1,
          maxTickets: 2,
          expired: key.toBase58() !== addresses[2],
        })),
      ),
    };
    const deps = createDeps({
      getGamesExpiringBefore: vi.fn(() => addresses.map(game)),
      gameAccounts: () => api,
    });

    await createExpiredGameScanner(deps).scan();

    expect(deps.getGamesExpiringBefore).toHaveBeenCalledWith(65_000, 25, addresses);
    expect(deps.getBlockchainTime).toHaveBeenCalledTimes(1);
    expect(api.fetchMultiple).toHaveBeenCalledTimes(1);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(deps.isExpired).toHaveBeenCalledWith(expect.anything(), 1_000);
    expect(deps.handleExpiredGame).toHaveBeenCalledTimes(2);
    expect(((deps.handleExpiredGame as any).mock.calls[0] as any[])[1]).toMatchObject({
      expired: true,
    });
    expect(deps.completeGame).toHaveBeenCalledWith(addresses[0]);
    expect(deps.updateGameMessage).toHaveBeenCalledTimes(2);
  });

  test("keeps paging while batches are full, up to the batch cap", async () => {
    const pages = [[await address(), await address()], [await address(), await address()], []];
    let call = 0;
    const deps = createDeps({
      batchSize: 2,
      maxBatches: 2,
      getGamesExpiringBefore: vi.fn(() => (pages[call++] ?? []).map(game)),
    });

    await createExpiredGameScanner(deps).scan();
    expect(deps.getGamesExpiringBefore).toHaveBeenCalledTimes(2);
    expect(deps.handleExpiredGame).toHaveBeenCalledTimes(4);
  });

  test("cleans up placeholder, missing and undecodable games and skips bad addresses", async () => {
    const missing = await address();
    const broken = await address();
    const failing = await address();
    const api = {
      fetch: vi.fn(async (key: PublicKey) => {
        if (key.toBase58() === broken) throw new Error("Invalid account discriminator");
        if (key.toBase58() === failing) throw new Error("rpc timeout");
        throw new TimbaAccountNotFoundError(key);
      }),
      fetchMultiple: vi.fn(async () => {
        throw new Error("batch failed");
      }),
    };
    const deps = createDeps({
      getGamesExpiringBefore: vi.fn(() => [
        game(""),
        game(DEFAULT_NULL_ADDRESS),
        game("not-an-address"),
        game(missing),
        game(broken),
        game(failing),
      ]),
      gameAccounts: () => api,
    });

    await createExpiredGameScanner(deps).scan();

    expect(api.fetch).toHaveBeenCalledTimes(3);
    expect((deps.cleanupOrphanedGame as any).mock.calls.map((args: any[]) => args[0])).toEqual([
      DEFAULT_NULL_ADDRESS,
      missing,
      broken,
    ]);
    expect(deps.handleExpiredGame).not.toHaveBeenCalled();
  });

  test("treats a null batch entry as an orphan and leaves unexpired or uncancelled games", async () => {
    const [gone, live, stuck] = await Promise.all([address(), address(), address()]);
    const deps = createDeps({
      getGamesExpiringBefore: vi.fn(() => [game(gone), game(live), game(stuck)]),
      gameAccounts: () => ({
        fetch: vi.fn(),
        fetchMultiple: vi.fn(async (keys: PublicKey[]) =>
          keys.map((key) => {
            if (key.toBase58() === gone) return null;
            return { expired: key.toBase58() === stuck };
          }),
        ),
      }),
      getBlockchainTime: vi.fn(async () => Number.NaN),
      handleExpiredGame: vi.fn(async () => false),
    });

    await createExpiredGameScanner(deps).scan();

    expect(deps.cleanupOrphanedGame).toHaveBeenCalledWith(gone);
    expect(deps.isExpired).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(deps.handleExpiredGame).toHaveBeenCalledTimes(1);
    expect(deps.completeGame).not.toHaveBeenCalled();
  });

  test("falls back to single fetches when the client has no batch method", async () => {
    const target = await address();
    const fetch = vi.fn(async () => ({ expired: true }));
    const deps = createDeps({
      getGamesExpiringBefore: vi.fn(() => [game(target)]),
      gameAccounts: () => ({ fetch }),
    });
    await createExpiredGameScanner(deps).scan();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(deps.handleExpiredGame).toHaveBeenCalledTimes(1);
  });

  test("skips a tick while the previous scan is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = createDeps({
      getBlockchainTime: vi.fn(async () => {
        await gate;
        return 1_000;
      }),
    });
    const scanner = createExpiredGameScanner(deps);

    const first = scanner.scan();
    await scanner.scan();
    expect(deps.getBlockchainTime).toHaveBeenCalledTimes(1);

    release();
    await first;
    await scanner.scan();
    expect(deps.getBlockchainTime).toHaveBeenCalledTimes(2);
  });

  test("logs and recovers from an unexpected scan failure", async () => {
    const deps = createDeps({
      getGamesExpiringBefore: vi.fn(() => {
        throw new Error("db locked");
      }),
    });
    const scanner = createExpiredGameScanner(deps);
    await scanner.scan();
    await scanner.scan();
    expect(deps.getGamesExpiringBefore).toHaveBeenCalledTimes(2);
  });
});
