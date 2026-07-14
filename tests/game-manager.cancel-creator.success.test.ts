import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

function resetGM() {
  // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("cancelGameWithCreator returns true on successful close", async () => {
  resetGM();
  const creator = Keypair.generate();
  const connection = {
    getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 6 } } } } }),
  } as any;
  const program = {
    programId: new PublicKey("BPFLoader1111111111111111111111111111111111"),
    provider: { connection },
    __captures: {} as Record<string, any>,
    methods: {
      closeGame: () => ({
        accounts: (accs: any) => {
          (program as any).__captures.closeGameAccounts = accs;
          return { instruction: async () => ({}) };
        },
      }),
    },
  } as any;
  const wallet = {
    getKeyPair: (_: bigint) => creator,
    sendTransaction: async () => "SIG",
    confirmTransaction: async () => {},
    getConnection: () => connection,
  } as any;
  const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);
  const tokenMint = Keypair.generate().publicKey;
  const gameToken = Keypair.generate().publicKey;
  const gameVault = Keypair.generate().publicKey;
  const gameTokenAccount = Keypair.generate().publicKey;
  const creatorTokenAccount = Keypair.generate().publicKey;
  (gm as any).resolveGameTokenAccounts = async (mint: PublicKey) => {
    expect(mint.toBase58()).toBe(tokenMint.toBase58());
    return {
      tokenProgram: TOKEN_PROGRAM_ID,
      gameToken,
      gameVault,
      gameTokenAccount,
    };
  };
  (gm as any).deriveAta = async () => creatorTokenAccount;
  const ok = await (gm as any).cancelGameWithCreator(
    new PublicKey("BPFLoader1111111111111111111111111111111111"),
    {
      creator: creator.publicKey.toBase58(),
      tokenMint: tokenMint.toBase58(),
    },
    "777",
    "ADDR",
    "coinflip",
  );
  expect(ok).toBe(true);

  const accounts = (program as any).__captures.closeGameAccounts;
  expect(accounts).toBeDefined();
  const ctx = accounts.gameTokenCtx;
  expect(ctx.tokenMint.toBase58()).toBe(tokenMint.toBase58());
  expect(ctx.gameToken.toBase58()).toBe(gameToken.toBase58());
  expect(ctx.gameVault.toBase58()).toBe(gameVault.toBase58());
  expect(ctx.gameTokenAccount.toBase58()).toBe(gameTokenAccount.toBase58());
  expect(ctx.tokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  expect(ctx.associatedTokenProgram.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  expect(accounts.creatorTokenAccount.toBase58()).toBe(creatorTokenAccount.toBase58());
  expect(accounts.tokenMint).toBeUndefined();
  expect(accounts.tokenProgram).toBeUndefined();
  expect(accounts.gameToken).toBeUndefined();
  expect(accounts.gameVault).toBeUndefined();
  expect(accounts.gameTokenAccount).toBeUndefined();
});

test("closeGameWithCreatorAuthority succeeds when wallet confirmation relies on probe recovery", async () => {
  resetGM();

  let transactionChecks = 0;
  const connection: any = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 0,
    getTransaction: async () => {
      transactionChecks += 1;
      return { meta: { err: null } };
    },
    getSignatureStatus: async () => ({ value: null }),
  };

  const wallet = WalletManager.createForTest(MNEMONIC, {
    connection,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });

  (wallet as any).confirmationTimeoutMs = 20;
  (wallet as any).signaturePollIntervalMs = 5;
  (wallet as any).postTimeoutProbeBackoffMs = 0;
  (wallet as any).postTimeoutProbeRetryDelayMs = 0;
  (wallet as any).postTimeoutProbeMaxAttempts = 1;

  const pendingSignatures = (wallet as any).pendingSignatures as Map<string, any>;
  const closeSig = "SIG_CLOSE_PROBE";

  (wallet as any).sendTransaction = async () => {
    pendingSignatures.set(closeSig, {
      blockhash: "BH",
      lastValidBlockHeight: 100,
      recordedAt: Date.now() - 5,
    });
    return closeSig;
  };

  const connectionForProgram = {
    getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 6 } } } } }),
  } as any;

  const program = {
    programId: new PublicKey("BPFLoader1111111111111111111111111111111111"),
    provider: { connection: connectionForProgram },
    methods: {
      closeGame: () => ({
        accounts: () => ({
          instruction: async () => ({}),
        }),
      }),
    },
  } as any;

  const gm = GameManager.getInstance(
    program,
    wallet as any,
    {
      getGameParticipants: () => [],
    } as any,
  );

  const creatorTelegramId = "777";
  const creatorKeypair = wallet.getKeyPair(BigInt(creatorTelegramId));

  (gm as any).resolveGameTokenAccounts = async () => ({
    tokenProgram: TOKEN_PROGRAM_ID,
    gameToken: Keypair.generate().publicKey,
    gameVault: Keypair.generate().publicKey,
    gameTokenAccount: Keypair.generate().publicKey,
  });
  (gm as any).deriveAta = async () => Keypair.generate().publicKey;

  const result = await (gm as any).closeGameWithCreatorAuthority({
    gamePda: new PublicKey("BPFLoader2111111111111111111111111111111111"),
    gameAccount: {
      tokenMint: Keypair.generate().publicKey.toBase58(),
      creator: creatorKeypair.publicKey.toBase58(),
    },
    creatorTelegramId,
    gameType: "coinflip",
  });

  expect(result.success).toBe(true);
  expect(result.tx).toBe(closeSig);
  expect(transactionChecks).toBeGreaterThanOrEqual(1);
  expect(pendingSignatures.has(closeSig)).toBe(false);
});

test("closeGameWithCreatorAuthority resubmits when helper is unavailable", async () => {
  resetGM();

  const creator = Keypair.generate();
  const connectionStub = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getSignatureStatus: async () => ({ value: null }),
    getBlockHeight: async () => 0,
    getTransaction: async () => ({ meta: { err: null } }),
    getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    }),
  } as any;

  const signatures = ["SIG_CLOSE_FALLBACK_1", "SIG_CLOSE_FALLBACK_2"];
  let sendCalls = 0;
  const wallet = {
    getKeyPair: (_: bigint) => creator,
    sendTransaction: async () => signatures[Math.min(sendCalls++, signatures.length - 1)],
    confirmTransaction: async (signature: string) => {
      if (signature === signatures[0]) {
        throw new Error("transaction confirmation timeout");
      }
    },
    getConnection: () => connectionStub,
  } as any;
  (wallet as any).sendAndConfirmWithResubmits = undefined;

  const program = {
    programId: new PublicKey("BPFLoader1111111111111111111111111111111111"),
    provider: { connection: connectionStub },
    methods: {
      closeGame: () => ({
        accounts: () => ({
          instruction: async () => ({}),
        }),
      }),
    },
  } as any;

  const gm = GameManager.getInstance(program, wallet, {
    getGameParticipants: () => [],
  } as any);

  (gm as any).resolveGameTokenAccounts = async () => ({
    tokenProgram: TOKEN_PROGRAM_ID,
    gameToken: Keypair.generate().publicKey,
    gameVault: Keypair.generate().publicKey,
    gameTokenAccount: Keypair.generate().publicKey,
  });
  (gm as any).deriveAta = async () => Keypair.generate().publicKey;

  const result = await (gm as any).closeGameWithCreatorAuthority({
    gamePda: new PublicKey("BPFLoader3211111111111111111111111111111111"),
    gameAccount: {
      tokenMint: Keypair.generate().publicKey.toBase58(),
      creator: creator.publicKey.toBase58(),
    },
    creatorTelegramId: "123",
    gameType: "coinflip",
  });

  expect(result.success).toBe(true);
  expect(result.tx).toBe(signatures[1]);
  expect(sendCalls).toBe(2);
});
