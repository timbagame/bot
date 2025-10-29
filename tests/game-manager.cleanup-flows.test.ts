import { describe, test, expect } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";
import {
  MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
  WSOL_MINT,
} from "../src/utils/constants";

function resetGM() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");
const programStub = { provider: { connection: {} } } as any;

const createWalletStub = (overrides: Record<string, any> = {}) => ({
  getConnection: () => ({}),
  getKeyPair: (_: bigint) => Keypair.generate(),
  getTokenMetadata: async () => ({ decimals: 6 }),
  getBalance: async () => MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
  getTokenBalance: async () => MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
  formatSolBalance: (lamports: number) => `${lamports} lamports`,
  ...overrides,
});

const createGameDbStub = (overrides: Record<string, any> = {}) => ({
  getGameParticipants: () => [],
  getPlayerPublicKey: () => null,
  getGame: () => ({ token_ticker: "ABC" }),
  ...overrides,
});

describe("GameManager cleanup flows", () => {
  test("unjoinPlayers returns count and calls unjoin per player", async () => {
    resetGM();
    const wallet = createWalletStub();
    const gameDb = createGameDbStub();
    const gm = GameManager.getInstance(programStub, wallet as any, gameDb as any);
    (gm as any).swapManager = { performJustInTimeSolSwap: async () => ({ swapped: true }) };
    (gm as any).ensureUnjoinFeePayerBalance = async () => ({ success: true });
    const players = [
      { telegramId: "1", pubkey: new PublicKey("BPFLoader2111111111111111111111111111111111"), isCreator: false },
      { telegramId: "2", pubkey: new PublicKey("BPFLoader3111111111111111111111111111111111"), isCreator: true },
    ];
    let calls = 0;
    (gm as any).unjoinPlayerFromGame = async () => { calls++; };
    const n = await (gm as any).unjoinPlayers(
      gamePda,
      { tokenMint: WSOL_MINT },
      players
    );
    expect(n).toBe(2);
    expect(calls).toBe(2);
  });

  test("executeCompleteCleanup cancels when all unjoined", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      programStub,
      createWalletStub() as any,
      createGameDbStub() as any
    );
    (gm as any).unjoinPlayers = async (_p: any, _ga: any, list: any[]) => list.length;
    (gm as any).cancelGameWithCreator = async () => true;
    const ok = await (gm as any).executeCompleteCleanup(
      gamePda,
      { tokenMint: WSOL_MINT },
      { available: [1,2], creator: { telegramId: "777" } },
      "ADDR"
    );
    expect(ok).toBe(true);
  });

  test("executeCompleteCleanup returns false when some players remain", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      programStub,
      createWalletStub() as any,
      createGameDbStub() as any
    );
    (gm as any).unjoinPlayers = async () => 1;
    const ok = await (gm as any).executeCompleteCleanup(
      gamePda,
      { tokenMint: WSOL_MINT },
      { available: [1,2], creator: { telegramId: "777" } },
      "ADDR"
    );
    expect(ok).toBe(false);
  });

  test("executePartialCleanup returns true iff unjoinedCount>0", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      programStub,
      createWalletStub() as any,
      createGameDbStub() as any
    );
    (gm as any).unjoinPlayers = async () => 0;
    const a = await (gm as any).executePartialCleanup(
      gamePda,
      { tokenMint: WSOL_MINT },
      { available: [1,2] },
      "ADDR"
    );
    (gm as any).unjoinPlayers = async () => 1;
    const b = await (gm as any).executePartialCleanup(
      gamePda,
      { tokenMint: WSOL_MINT },
      { available: [1,2] },
      "ADDR"
    );
    expect(a).toBe(false);
    expect(b).toBe(true);
  });

  test("unjoinPlayers falls back to creator authority when player cannot cover fees", async () => {
    resetGM();
    const creatorKp = Keypair.generate();
    const playerKp = Keypair.generate();
    const playerPubkey = new PublicKey("BPFLoader4111111111111111111111111111111111");

    const walletStub = createWalletStub({
      getKeyPair: (id: bigint) => {
        if (id === BigInt(1)) return creatorKp;
        if (id === BigInt(404)) return playerKp;
        throw new Error("missing");
      },
      getTokenMetadata: async () => ({ decimals: 6 }),
    });

    const gm = GameManager.getInstance(
      programStub,
      walletStub as any,
      createGameDbStub() as any
    );
    (gm as any).swapManager = { performJustInTimeSolSwap: async () => ({ swapped: true }) };
    (gm as any).ensureUnjoinFeePayerBalance = async ({ telegramId }: { telegramId: string }) => {
      if (telegramId === "404") {
        return { success: false, reason: "no sol" };
      }
      return { success: true };
    };

    let usedCreator = false;
    (gm as any).unjoinPlayerFromGame = async (
      _pda: PublicKey,
      authority: Keypair,
      target: PublicKey
    ) => {
      expect(target.equals(playerPubkey)).toBe(true);
      expect(authority).toBe(creatorKp);
      usedCreator = true;
    };

    const count = await (gm as any).unjoinPlayers(
      gamePda,
      { tokenMint: WSOL_MINT },
      [
        {
          telegramId: "404",
          pubkey: playerPubkey,
          isCreator: false,
        },
      ],
      "1"
    );

    expect(count).toBe(1);
    expect(usedCreator).toBe(true);
  });

  test("ensureUnjoinFeePayerBalance succeeds when SOL balance already sufficient", async () => {
    resetGM();
    const wallet = createWalletStub({
      getBalance: async () => MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
      getTokenBalance: async () => 0,
    });
    const gm = GameManager.getInstance(
      programStub,
      wallet as any,
      createGameDbStub() as any
    );
    let swapCalls = 0;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => {
        swapCalls++;
        return { swapped: true };
      },
    };

    const result = await (gm as any).ensureUnjoinFeePayerBalance({
      telegramId: "10",
      tokenMint: WSOL_MINT,
      tokenDecimals: 6,
      tokenTicker: "SOL",
      userKeypair: Keypair.generate(),
      logContext: "unit-test",
    });

    expect(result).toEqual({ success: true });
    expect(swapCalls).toBe(0);
  });

  test("ensureUnjoinFeePayerBalance fails when no spare tokens are available", async () => {
    resetGM();
    const wallet = createWalletStub({
      getBalance: async () => 0,
      getTokenBalance: async () => 0,
    });
    const gm = GameManager.getInstance(
      programStub,
      wallet as any,
      createGameDbStub() as any
    );
    let swapCalls = 0;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => {
        swapCalls++;
        return { swapped: false };
      },
    };

    const result = await (gm as any).ensureUnjoinFeePayerBalance({
      telegramId: "42",
      tokenMint: WSOL_MINT,
      tokenDecimals: 6,
      tokenTicker: "ABC",
      userKeypair: Keypair.generate(),
      logContext: "unit-test",
    });

    expect(result.success).toBe(false);
    expect((result as any).reason).toContain("No spare");
    expect(swapCalls).toBe(0);
  });

  test("ensureUnjoinFeePayerBalance swaps tokens and succeeds when top-up completes", async () => {
    resetGM();
    let balanceCalls = 0;
    const wallet = createWalletStub({
      getBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1 ? 0 : MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS;
      },
      getTokenBalance: async () => 5_000_000,
    });
    const gm = GameManager.getInstance(
      programStub,
      wallet as any,
      createGameDbStub() as any
    );
    let swapCalls = 0;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => {
        swapCalls++;
        return { swapped: true };
      },
    };

    const result = await (gm as any).ensureUnjoinFeePayerBalance({
      telegramId: "77",
      tokenMint: WSOL_MINT,
      tokenDecimals: 6,
      tokenTicker: "ABC",
      userKeypair: Keypair.generate(),
      logContext: "unit-test",
    });

    expect(result).toEqual({ success: true });
    expect(swapCalls).toBe(1);
  });

  test("ensureUnjoinFeePayerBalance reports failure when post-swap SOL is still low", async () => {
    resetGM();
    let balanceCalls = 0;
    const wallet = createWalletStub({
      getBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1 ? 0 : MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS - 1;
      },
      getTokenBalance: async () => 5_000_000,
    });
    const gm = GameManager.getInstance(
      programStub,
      wallet as any,
      createGameDbStub() as any
    );
    let swapCalls = 0;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => {
        swapCalls++;
        return { swapped: true };
      },
    };

    const result = await (gm as any).ensureUnjoinFeePayerBalance({
      telegramId: "78",
      tokenMint: WSOL_MINT,
      tokenDecimals: 6,
      tokenTicker: "ABC",
      userKeypair: Keypair.generate(),
      logContext: "unit-test",
    });

    expect(result.success).toBe(false);
    expect((result as any).reason).toContain("Shortfall");
    expect(swapCalls).toBe(1);
  });
});
