import { describe, test, expect } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";
import {
  LAMPORTS_PER_SOL,
  MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
} from "../src/utils/constants";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function baseProgram(gameAccount: any) {
  return { account: { game: { fetch: async () => gameAccount } } } as any;
}

function baseWallet(overrides: Partial<any> = {}) {
  const player = Keypair.generate();
  return {
    getKeyPair: (_: bigint) => player,
    getTokenBalance: async () => 0,
    getTokenMetadata: async () => ({ decimals: 9 }),
    getBalance: async () => MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
    formatSolBalance: (lamports: number) =>
      (lamports / LAMPORTS_PER_SOL).toFixed(6),
    ...overrides,
  } as any;
}

function baseDb(overrides: Partial<any> = {}) {
  return {
    getGame: (_: string) => ({ status: "active", token_mint: "M", token_ticker: "TOK", amount: 1_000_000_000 }),
    ...overrides,
  } as any;
}

describe("GameManager.joinGame guards", () => {
  test("returns error when game not found in DB", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      baseProgram({}),
      baseWallet(),
      baseDb({ getGame: () => null })
    );
    const res = await gm.joinGame(new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(), 1n);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Game not found/i);
  });

  test("returns error when game not active", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      baseProgram({}),
      baseWallet(),
      baseDb({ getGame: () => ({ status: "completed" }) })
    );
    const res = await gm.joinGame(new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58(), 1n);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no longer active/i);
  });

  test("returns error when token data missing", async () => {
    resetGM();
    const gm = GameManager.getInstance(
      baseProgram({}),
      baseWallet(),
      baseDb({ getGame: () => ({ status: "active", token_mint: undefined, token_ticker: undefined }) })
    );
    const res = await gm.joinGame(new PublicKey("BPFLoader3111111111111111111111111111111111").toBase58(), 1n);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Game data incomplete/i);
  });

  test("returns error when already joined", async () => {
    resetGM();
    const program = baseProgram({ ticketsCount: 0, maxTickets: 2, gameType: { coinflip: {} }, ticketAmount: 1_000_000_000 });
    const gm = GameManager.getInstance(program, baseWallet(), baseDb());
    (gm as any).isPlayerInGame = async () => true;
    const res = await gm.joinGame(new PublicKey("BPFLoader4111111111111111111111111111111111").toBase58(), 1n);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already joined/i);
  });

  test("returns error when game full", async () => {
    resetGM();
    const program = baseProgram({ ticketsCount: 2, maxTickets: 2, gameType: { coinflip: {} }, ticketAmount: 1_000_000_000 });
    const gm = GameManager.getInstance(program, baseWallet(), baseDb());
    (gm as any).isPlayerInGame = async () => false;
    const res = await gm.joinGame(new PublicKey("BPFLoader5111111111111111111111111111111111").toBase58(), 1n);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already full/i);
  });

  test("returns error on insufficient balance for coinflip", async () => {
    resetGM();
    const program = baseProgram({ ticketsCount: 0, maxTickets: 2, gameType: { coinflip: {} }, ticketAmount: 1_000_000_000 });
    const gm = GameManager.getInstance(
      program,
      baseWallet({ getTokenBalance: async () => 100 }),
      baseDb({ getGame: () => ({ status: "active", token_mint: "M", token_ticker: "TOK" }) })
    );
    (gm as any).isPlayerInGame = async () => false;
    const res = await gm.joinGame(new PublicKey("BPFLoader6111111111111111111111111111111111").toBase58(), 1n);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not enough TOK/i);
  });

  test("returns error when SOL top-up needed but no spare tokens for swap", async () => {
    resetGM();
    const program = baseProgram({
      ticketsCount: 0,
      maxTickets: 2,
      gameType: { coinflip: {} },
      ticketAmount: 1_000_000_000,
    });
    const wallet = baseWallet({
      getTokenBalance: async () => 1_000_000_000,
      getBalance: async () => 0,
    });
    const gm = GameManager.getInstance(
      program,
      wallet,
      baseDb({ getGame: () => ({ status: "active", token_mint: "M", token_ticker: "TOK" }) })
    );
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: () => {
        throw new Error("swap should not be attempted without spare tokens");
      },
    };

    const res = await gm.joinGame(new PublicKey("BPFLoader7111111111111111111111111111111111").toBase58(), 1n);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not enough SOL to complete this/i);
    expect(res.error).toMatch(/no spare tokens to convert into SOL fees/i);
  });
});
