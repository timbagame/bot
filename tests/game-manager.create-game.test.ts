import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";
import { PDAManager } from "../src/utils/pda";
import { WSOL_MINT } from "../src/utils/constants";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function makeProgram() {
  const programId = new PublicKey("BPFLoader1111111111111111111111111111111111");
  return {
    programId,
    methods: {
      initializeGame: (_cfg: any, _hash: any) => ({
        accounts: (_: any) => ({ instruction: async () => ({}) }),
      }),
      joinGame: () => ({
        accounts: (_: any) => ({ instruction: async () => ({}) }),
      }),
    },
    account: { game: { fetch: async () => ({}) } },
  } as any;
}

describe("GameManager.createGame", () => {
  test("surface helpful error when SOL auto-wrap cannot proceed", async () => {
    resetGM();
    const wallet = {
      getTokenMetadata: async () => ({ decimals: 9 }),
      getKeyPair: (_: bigint) => Keypair.generate(),
      getTokenBalance: async () => 0,
      getBalance: async () => 2_000_000,
      wrapSol: async () => {
        throw new Error("should not wrap");
      },
      formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
      formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    } as any;
    const gm = GameManager.getInstance(makeProgram(), wallet, { savePlayerMapping: () => {} } as any);
    const res = await gm.createGame(
      "coinflip",
      {
        amount: 1_000_000,
        tokenMint: WSOL_MINT,
        tokenTicker: "SOL",
        isSol: false,
        requestedNativeSol: true,
      },
      2,
      2,
      60,
      1n
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Not enough SOL");
  });

  test("errors on insufficient balance with formatted message", async () => {
    resetGM();
    const wallet = {
      getTokenMetadata: async () => ({ decimals: 6 }),
      getKeyPair: (_: bigint) => Keypair.generate(),
      getTokenBalance: async () => 500_000,
      getBalance: async () => 5_000_000,
      formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    } as any;
    const gm = GameManager.getInstance(makeProgram(), wallet, { savePlayerMapping: () => {} } as any);
    const res = await gm.createGame("coinflip", { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false }, 2, 2, 60, 1n);
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Insufficient balance");
    expect(String(res.error)).toContain("0.5 TOK");
  });

  test("returns oracle unavailable when unhealthy", async () => {
    resetGM();
    const wallet = {
      getTokenMetadata: async () => ({ decimals: 6 }),
      getKeyPair: (_: bigint) => Keypair.generate(),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    } as any;
    const db = { savePlayerMapping: () => {} } as any;
    const gm = GameManager.getInstance(makeProgram(), wallet, db);
    // Patch oracle client on the instance
    (gm as any).oracleClient = { isHealthy: async () => false };
    const res = await gm.createGame("coinflip", { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false }, 2, 2, 60, 1n);
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Oracle service is unavailable");
  });

  test("happy path saves game and auto-joins creator", async () => {
    resetGM();
    const wallet = {
      getTokenMetadata: async () => ({ decimals: 6 }),
      getKeyPair: (_: bigint) => Keypair.generate(),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
      sendTransaction: async () => "SIG",
    } as any;
    const saved: any[] = [];
    const db = {
      savePlayerMapping: () => {},
      saveGame: (...args: any[]) => { saved.push(args); },
    } as any;
    const program = makeProgram();
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({ randomHash: "deadbeef" }),
      hexToBuffer: (_: string) => Buffer.from("deadbeef", "hex"),
    };
    // Derivation + confirmation + auto-join patched
    const pda = new PublicKey("11111111111111111111111111111111");
    const original = (PDAManager as any).getGamePDA;
    (PDAManager as any).getGamePDA = () => pda;
    (gm as any).confirmTransactionWithRecovery = async () => true;
    (gm as any).handleGameAutoJoinPure = async () => ({ success: true });

    const res = await gm.createGame(
      "coinflip",
      { amount: 1_000_000, tokenMint: "11111111111111111111111111111111", tokenTicker: "TIMBA", isSol: false },
      2,
      2,
      60,
      1n,
      100
    );
    expect(res.success).toBe(true);
    expect(res.gameAddress).toBe(pda.toBase58());
    expect(saved.length).toBe(1);

    // restore
    (PDAManager as any).getGamePDA = original;
  });

  test("errors are formatted via logAndFormatError when thrown", async () => {
    resetGM();
    const wallet = {
      getTokenMetadata: async () => { throw new Error("metadata fail"); },
      getKeyPair: (_: bigint) => Keypair.generate(),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    } as any;
    const gm = GameManager.getInstance(makeProgram(), wallet, { savePlayerMapping: () => {} } as any);
    const res = await gm.createGame("coinflip", { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false }, 2, 2, 60, 1n);
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Something went wrong");
  });
});
