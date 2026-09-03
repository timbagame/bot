import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { GameManager } from "../src/utils/game";

describe("GameManager join initializes missing ATAs", () => {
  test("joinGame creates an associated token account before joining", async () => {
    GameManager.resetForTest();

    const playerKp = Keypair.generate();
    const tokenMint = Keypair.generate().publicKey;
    const gamePda = new PublicKey("BPFLoader2111111111111111111111111111111111");

    let recordedInstructions: TransactionInstruction[] | undefined;

    const program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
      account: {
        game: {
          fetch: async () => ({
            isPrivate: false,
            ticketsCount: 0,
            maxTickets: 2,
            gameType: { coinflip: {} },
            ticketAmount: 1_000_000,
            tokenMint,
          }),
        },
      },
      methods: {
        joinGame: () => ({
          accounts: () => ({
            instruction: async () =>
              new TransactionInstruction({
                keys: [],
                programId: new PublicKey("11111111111111111111111111111111"),
                data: Buffer.alloc(0),
              }),
          }),
        }),
      },
    } as any;

    const connection = {
      getAccountInfo: async () => null,
    } as any;

    const wallet = {
      getKeyPair: () => playerKp,
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 10_000_000,
      getBalance: async () => 10_000_000,
      sendTransaction: async (instructions: TransactionInstruction[]): Promise<string> => {
        recordedInstructions = instructions;
        return "SIG-ATA";
      },
      getConnection: () => connection,
      clearCachedWalletData: () => {},
    } as any;

    const participantCalls: any[] = [];
    const gameDb = {
      getGame: () => ({
        status: "active",
        token_mint: tokenMint.toBase58(),
        token_ticker: "TOK",
      }),
      savePlayerMapping: () => {},
      saveGameParticipant: (...args: any[]) => participantCalls.push(args),
      removeGameParticipant: () => {},
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => ({ swapped: false }),
    };
    (gm as any).confirmTransactionWithRecovery = async (signature: string): Promise<string> =>
      signature;
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).verifyParticipantJoin = async () => true;

    const gameVault = Keypair.generate().publicKey;
    const gameVaultTokenAccount = Keypair.generate().publicKey;
    const playerTokenAccount = Keypair.generate().publicKey;
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
    });
    (gm as any).deriveAta = async () => playerTokenAccount;

    const result = await gm.joinGame(gamePda.toBase58(), 1n);

    expect(result.success).toBe(true);
    expect(recordedInstructions?.length).toBe(2);
    const ataInstruction = recordedInstructions?.[0];
    const expectedAtaInstruction = createAssociatedTokenAccountIdempotentInstruction(
      playerKp.publicKey,
      playerTokenAccount,
      playerKp.publicKey,
      tokenMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    expect(ataInstruction?.programId?.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    const tokenProgramKey = ataInstruction?.keys?.find(
      (key) => key.pubkey?.toBase58?.() === TOKEN_PROGRAM_ID.toBase58(),
    );
    expect(tokenProgramKey).toBeDefined();
    expect(ataInstruction?.data).toEqual(expectedAtaInstruction.data);
    const joinInstruction = recordedInstructions?.[1];
    expect(joinInstruction).toBeDefined();
  });

  test("joinGame resubmits with idempotent ATA creation", async () => {
    GameManager.resetForTest();

    const playerKp = Keypair.generate();
    const tokenMint = Keypair.generate().publicKey;
    const gamePda = new PublicKey("BPFLoader2111111111111111111111111111111111");

    const expectedAtaInstruction = createAssociatedTokenAccountIdempotentInstruction(
      playerKp.publicKey,
      new PublicKey("6GyJRLV8EtRcR1xoss6aMBJXnPCxgoqBrC4UpAx2Jkgg"),
      playerKp.publicKey,
      tokenMint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
      account: {
        game: {
          fetch: async () => ({
            isPrivate: false,
            ticketsCount: 0,
            maxTickets: 2,
            gameType: { coinflip: {} },
            ticketAmount: 1_000_000,
            tokenMint,
          }),
        },
      },
      methods: {
        joinGame: () => ({
          accounts: () => ({
            instruction: async () =>
              new TransactionInstruction({
                keys: [],
                programId: new PublicKey("11111111111111111111111111111111"),
                data: Buffer.alloc(0),
              }),
          }),
        }),
      },
    } as any;

    const connection = {
      getAccountInfo: async () => null,
    } as any;

    let ataCreated = false;
    const wallet = {
      getKeyPair: () => playerKp,
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 10_000_000,
      getBalance: async () => 10_000_000,
      sendTransaction: async () => {
        ataCreated = true;
        return "SIG-ATA";
      },
      confirmTransaction: async () => {},
      sendInstructionsWithFallback: async (
        instructions: TransactionInstruction[],
      ): Promise<string> => {
        const ataInstruction = instructions[0];
        const isIdempotent = ataInstruction?.data?.equals(expectedAtaInstruction.data);
        if (ataCreated && !isIdempotent) {
          throw new Error("Token account already in use");
        }
        ataCreated = true;
        return "SIG-RESUBMIT";
      },
      getConnection: () => connection,
      clearCachedWalletData: () => {},
      formatSolBalance: () => "0 SOL",
    } as any;

    const participantCalls: any[] = [];
    const gameDb = {
      getGame: () => ({
        status: "active",
        token_mint: tokenMint.toBase58(),
        token_ticker: "TOK",
      }),
      savePlayerMapping: () => {},
      saveGameParticipant: (...args: any[]) => participantCalls.push(args),
      removeGameParticipant: () => {},
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => ({ swapped: false }),
    };
    (gm as any).confirmTransactionWithRecovery = async (
      signature: string,
      _gamePda: PublicKey,
      _label: string,
      _player: PublicKey,
      resubmit?: (attempt: number, previousSignature: string) => Promise<string>,
    ): Promise<string> => {
      if (!resubmit) {
        return signature;
      }
      return await resubmit(0, signature);
    };
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).verifyParticipantJoin = async () => true;

    const gameVault = Keypair.generate().publicKey;
    const gameVaultTokenAccount = Keypair.generate().publicKey;
    const playerTokenAccount = expectedAtaInstruction.keys[1]?.pubkey as PublicKey;
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
    });
    (gm as any).deriveAta = async () => playerTokenAccount;

    const result = await gm.joinGame(gamePda.toBase58(), 1n);

    expect(result.success).toBe(true);
    expect(ataCreated).toBe(true);
  });
});
