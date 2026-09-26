import { PublicKey } from "#solana";
import type { GameData } from "../types";
import { DEFAULT_NULL_ADDRESS } from "../utils/constants";
import { isMissingAccountError } from "../utils/account-errors";

type GameAccountApi = {
  fetch(address: PublicKey): Promise<any>;
  fetchMultiple?(addresses: PublicKey[]): Promise<Array<any | null>>;
};

export type ExpiredGameScanDeps = {
  getGamesExpiringBefore: (cutoffMs: number, limit: number, exclude: string[]) => GameData[];
  gameAccounts: () => GameAccountApi;
  getBlockchainTime: () => Promise<number>;
  isExpired: (gameAccount: any, currentTimeSeconds?: number) => boolean;
  handleExpiredGame: (gamePda: PublicKey, gameAccount: any) => Promise<unknown>;
  completeGame: (gameAddress: string) => void;
  updateGameMessage: (gameAddress: string, game: GameData) => Promise<void>;
  cleanupOrphanedGame: (gameAddress: string) => Promise<void>;
  lookaheadMs: number;
  now?: () => number;
  batchSize?: number;
  maxBatches?: number;
};

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_BATCHES = 10;

const isOrphanedAccountError = (error: unknown): boolean =>
  isMissingAccountError(error) ||
  (error instanceof Error && error.message.includes("Invalid account discriminator"));

/**
 * Build the periodic expired-game sweep. Each run reads blockchain time once,
 * loads each batch of candidate games with one getMultipleAccounts call, and
 * hands the loaded account to the cancellation path. Overlapping runs are
 * skipped so a slow sweep never stacks up behind the interval.
 */
export const createExpiredGameScanner = (deps: ExpiredGameScanDeps) => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? DEFAULT_MAX_BATCHES;
  let scanning = false;

  const processExpiredGame = async (
    game: GameData,
    gamePda: PublicKey,
    gameAccount: any,
  ): Promise<void> => {
    console.log(
      `Processing expired game ${game.game_address} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`,
    );

    const result = await deps.handleExpiredGame(gamePda, gameAccount);
    if (result) {
      console.log(`✅ Successfully processed expired game ${game.game_address}`);
      deps.completeGame(game.game_address);
      await deps.updateGameMessage(game.game_address, game);
    } else {
      console.log(`ℹ️ No cancellation yet for expired game ${game.game_address}; will retry`);
    }
  };

  /** Batch-load accounts; games the batch could not answer are fetched one by one. */
  const loadAccounts = async (
    candidates: Array<{ game: GameData; gamePda: PublicKey }>,
  ): Promise<Map<string, any | null>> => {
    const loaded = new Map<string, any | null>();
    const api = deps.gameAccounts();
    if (candidates.length === 0 || typeof api.fetchMultiple !== "function") {
      return loaded;
    }
    try {
      const accounts = await api.fetchMultiple(candidates.map((candidate) => candidate.gamePda));
      candidates.forEach((candidate, index) => {
        loaded.set(candidate.game.game_address, accounts[index] ?? null);
      });
    } catch (error) {
      console.warn("Batch expired-game lookup failed; checking games individually:", error);
    }
    return loaded;
  };

  const scan = async (): Promise<void> => {
    if (scanning) {
      console.log("⏭️ Expired-game scan still running; skipping this tick");
      return;
    }
    scanning = true;
    try {
      const nowMs = (deps.now ?? Date.now)();
      const cutoffMs = nowMs + deps.lookaheadMs;
      const processedAddresses: string[] = [];
      const blockTime = await deps.getBlockchainTime();
      const currentTime =
        typeof blockTime === "number" && Number.isFinite(blockTime) ? blockTime : undefined;
      let batchCount = 0;
      let expiringGames: GameData[] = [];

      do {
        expiringGames = deps.getGamesExpiringBefore(cutoffMs, batchSize, processedAddresses);
        if (expiringGames.length === 0) {
          break;
        }

        const candidates: Array<{ game: GameData; gamePda: PublicKey }> = [];
        for (const game of expiringGames) {
          if (!game.game_address) {
            console.log(`🗑️ Skipping game with null address`);
            continue;
          }

          processedAddresses.push(game.game_address);

          if (game.game_address === DEFAULT_NULL_ADDRESS) {
            console.log(`🗑️ Skipping placeholder game address ${game.game_address}`);
            await deps.cleanupOrphanedGame(game.game_address);
            continue;
          }

          try {
            candidates.push({ game, gamePda: new PublicKey(game.game_address) });
          } catch {
            console.log(`🗑️ Skipping game with invalid address format: ${game.game_address}`);
          }
        }

        const accounts = await loadAccounts(candidates);
        for (const { game, gamePda } of candidates) {
          try {
            const gameAccount = accounts.has(game.game_address)
              ? accounts.get(game.game_address)
              : await deps.gameAccounts().fetch(gamePda);
            if (!gameAccount) {
              await deps.cleanupOrphanedGame(game.game_address);
              continue;
            }

            if (deps.isExpired(gameAccount, currentTime)) {
              await processExpiredGame(game, gamePda, gameAccount);
            }
          } catch (error) {
            if (isOrphanedAccountError(error)) {
              await deps.cleanupOrphanedGame(game.game_address);
            } else {
              console.error(`Error processing game ${game.game_address}:`, error);
            }
          }
        }

        batchCount += 1;
      } while (expiringGames.length === batchSize && batchCount < maxBatches);
    } catch (error) {
      console.error("Error in periodic game check:", error);
    } finally {
      scanning = false;
    }
  };

  return { scan };
};
