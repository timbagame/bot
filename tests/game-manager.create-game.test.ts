import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PDAManager } from "../src/utils/pda";
import { WSOL_MINT } from "../src/utils/constants";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function createConnectionStub(owner: PublicKey = TOKEN_PROGRAM_ID) {
  return {
    getAccountInfo: async () => ({ owner }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    }),
  } as any;
}

function makeProgram(connection = createConnectionStub()) {
  const programId = new PublicKey("BPFLoader1111111111111111111111111111111111");
  const captures: Record<string, any> = {};
  return {
    programId,
    provider: { connection },
    __captures: captures,
    methods: {
      initializeGame: (_cfg: any, _hash: any) => ({
        accounts: (accs: any) => {
          captures["initializeGameAccounts"] = accs;
          return { instruction: async () => ({}) };
        },
      }),
      joinGame: () => ({
        accounts: (accs: any) => {
          captures["joinGameAccounts"] = accs;
          return { instruction: async () => ({}) };
        },
      }),
    },
    account: { game: { fetch: async () => ({}) } },
  } as any;
}

function makeWallet(overrides: Record<string, any>) {
  const { connection: providedConnection, ...rest } = overrides;
  const connection = providedConnection ?? createConnectionStub();
  const wallet: any = {
    connection,
    getConnection: () => connection,
    getKeyPair: (_: bigint) => Keypair.generate(),
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toString(),
    ...rest,
  };

  wallet.connection = connection;
  if (!wallet.getConnection) {
    wallet.getConnection = () => connection;
  }

  return wallet;
}

describe("GameManager.createGame", () => {
  test("surface helpful error when SOL auto-wrap cannot proceed", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 0,
      getBalance: async () => 2_000_000,
      wrapSol: async () => {
        throw new Error("should not wrap");
      },
      formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
    });
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, {
      savePlayerMapping: () => {},
    } as any);
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
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 500_000,
      getBalance: async () => 5_000_000,
    });
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, {
      savePlayerMapping: () => {},
    } as any);
    const res = await gm.createGame("coinflip", { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false }, 2, 2, 60, 1n);
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Insufficient balance");
    expect(String(res.error)).toContain("0.5 TOK");
  });

  test("returns oracle unavailable when unhealthy", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
    });
    const db = { savePlayerMapping: () => {} } as any;
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);
    // Patch oracle client on the instance
    (gm as any).oracleClient = { isHealthy: async () => false };
    const res = await gm.createGame("coinflip", { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false }, 2, 2, 60, 1n);
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Oracle service is unavailable");
  });

  test("happy path saves game and auto-joins creator", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      sendTransaction: async () => "SIG",
    });
    const saved: any[] = [];
    const db = {
      savePlayerMapping: () => {},
      saveGame: (...args: any[]) => { saved.push(args); },
    } as any;
    const program = makeProgram(wallet.connection);
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({ randomHash: "deadbeef" }),
      hexToBuffer: (_: string) => Buffer.from("deadbeef", "hex"),
    };
    const gameToken = Keypair.generate().publicKey;
    const gameVault = Keypair.generate().publicKey;
    const gameTokenAccount = Keypair.generate().publicKey;
    const creatorTokenAccount = Keypair.generate().publicKey;
    (gm as any).resolveGameTokenAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameToken,
      gameVault,
      gameTokenAccount,
    });
    (gm as any).deriveAta = async () => creatorTokenAccount;
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

    const captures = (program as any).__captures;
    const accounts = captures["initializeGameAccounts"];
    expect(accounts).toBeDefined();
    expect(accounts.gameTokenCtx).toBeDefined();
    const ctx = accounts.gameTokenCtx;
    expect(ctx.tokenMint.toBase58()).toBe("11111111111111111111111111111111");
    expect(ctx.gameToken.toBase58()).toBe(gameToken.toBase58());
    expect(ctx.gameVault.toBase58()).toBe(gameVault.toBase58());
    expect(ctx.gameTokenAccount.toBase58()).toBe(
      gameTokenAccount.toBase58(),
    );
    expect(ctx.tokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(ctx.associatedTokenProgram.toBase58()).toBe(
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    );
    expect(accounts.creatorTokenAccount.toBase58()).toBe(
      creatorTokenAccount.toBase58(),
    );
    expect(accounts.tokenMint).toBeUndefined();
    expect(accounts.tokenProgram).toBeUndefined();
    expect(accounts.associatedTokenProgram).toBeUndefined();
    expect(accounts.gameToken).toBeUndefined();
    expect(accounts.gameVault).toBeUndefined();
    expect(accounts.gameTokenAccount).toBeUndefined();

    // restore
    (PDAManager as any).getGamePDA = original;
  });

  test("errors are formatted via logAndFormatError when thrown", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => {
        throw new Error("metadata fail");
      },
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
    });
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, {
      savePlayerMapping: () => {},
    } as any);
    const res = await gm.createGame("coinflip", { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false }, 2, 2, 60, 1n);
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Something went wrong");
  });
});
