import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";

const GAME_ADDRESS = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  GameManager.resetForTest();
});

async function setup(options: { fetch?: () => Promise<unknown>; creatorId?: string | null } = {}) {
  const creator = await Keypair.generate();
  const gameAccount = { creator: creator.publicKey };
  const closeInstruction = { ix: "close" };
  const closeAccountsSeen: unknown[] = [];
  const program: any = {
    account: { game: { fetch: options.fetch ?? (async () => gameAccount) } },
    methods: {
      closeGame: () => ({
        accounts: (accounts: unknown) => {
          closeAccountsSeen.push(accounts);
          return { instruction: async () => closeInstruction };
        },
      }),
    },
  };
  const wallet: any = { getKeyPair: vi.fn(async () => creator) };
  const db: any = {
    getPlayerTelegramId: vi.fn(() => ("creatorId" in options ? options.creatorId : "321")),
  };
  const gm: any = GameManager.getInstance(program, wallet, db);
  gm.buildCloseGameAccounts = vi.fn(async () => ({ game: GAME_ADDRESS }));
  gm.sendInstructionsWithFallback = vi.fn(async () => "CLOSE_SIG");
  gm.confirmTransactionWithRecovery = vi.fn(async (sig: string) => `${sig}_CONFIRMED`);
  return { gm, wallet, db, creator, gameAccount, closeInstruction, closeAccountsSeen };
}

describe("closeGameWithCreatorAuthority failure", () => {
  test("returns a friendly error and logs the failure when the close cannot be confirmed", async () => {
    const { gm, creator, gameAccount } = await setup();
    gm.confirmTransactionWithRecovery = vi.fn(async () => {
      throw new Error("close not confirmed");
    });
    const result = await gm.closeGameWithCreatorAuthority({
      gamePda: new PublicKey(GAME_ADDRESS),
      gameAccount,
      creatorTelegramId: "321",
      gameType: "coinflip",
    });
    expect(result.success).toBe(false);
    expect(result.tx).toBeUndefined();
    expect(result.error).toContain("Something went wrong");
    expect(errorSpy).toHaveBeenCalledWith(
      `❌ Failed to close coinflip game ${GAME_ADDRESS}:`,
      "close not confirmed",
    );
    expect(gm.confirmTransactionWithRecovery).toHaveBeenCalledWith(
      "CLOSE_SIG",
      new PublicKey(GAME_ADDRESS),
      "Game close",
      creator.publicKey,
      expect.any(Function),
    );
  });

  test("uses the caller's failure prefix and tolerates a non-Error rejection", async () => {
    const { gm, gameAccount } = await setup();
    gm.sendInstructionsWithFallback = vi.fn(async () => {
      throw "plain string failure";
    });
    const result = await gm.closeGameWithCreatorAuthority({
      gamePda: new PublicKey(GAME_ADDRESS),
      gameAccount,
      creatorTelegramId: "321",
      gameType: "giveaway",
      failurePrefix: "custom failure for",
    });
    expect(result.success).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      `custom failure for ${GAME_ADDRESS}:`,
      "plain string failure",
    );
  });
});

describe("cancelGameWithPlayerKeys", () => {
  test("closes the game with the creator's key looked up from the database", async () => {
    const { gm, db, wallet, gameAccount, closeAccountsSeen } = await setup();
    const result = await gm.cancelGameWithPlayerKeys(new PublicKey(GAME_ADDRESS), "coinflip");
    expect(result).toEqual({ success: true, tx: "CLOSE_SIG_CONFIRMED" });
    expect(db.getPlayerTelegramId).toHaveBeenCalledWith(gameAccount.creator.toBase58());
    expect(wallet.getKeyPair).toHaveBeenCalledWith(321n);
    expect(closeAccountsSeen).toEqual([{ game: GAME_ADDRESS }]);
  });

  test("refuses to cancel when the creator is unknown", async () => {
    const { gm, wallet } = await setup({ creatorId: null });
    const result = await gm.cancelGameWithPlayerKeys(new PublicKey(GAME_ADDRESS), "coinflip");
    expect(result).toEqual({ success: false, error: "Creator not found in database" });
    expect(wallet.getKeyPair).not.toHaveBeenCalled();
    expect(gm.sendInstructionsWithFallback).not.toHaveBeenCalled();
  });

  test("reports a failed game account read as a friendly error", async () => {
    const { gm } = await setup({
      fetch: async () => {
        throw new Error("rpc exploded");
      },
    });
    const result = await gm.cancelGameWithPlayerKeys(new PublicKey(GAME_ADDRESS), "lottery");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Something went wrong");
    expect(errorSpy).toHaveBeenCalledWith(
      `❌ Error closing lottery game ${GAME_ADDRESS}:`,
      expect.objectContaining({ message: "rpc exploded" }),
    );
    expect(gm.sendInstructionsWithFallback).not.toHaveBeenCalled();
  });
});
