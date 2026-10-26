import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { getBase64EncodedWireTransaction, partiallySignTransactionWithSigners } from "@solana/kit";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair, TransactionInstruction } from "#solana";
import { TOKEN_PROGRAM_ID } from "#token";
import { decodeGameTransaction } from "../src/utils/game-transaction";

const TEST_ORACLE = await Keypair.generate();

async function signGameTransactionAsOracle(txBase64: string): Promise<string> {
  const transaction = decodeGameTransaction(txBase64);
  const signed = await partiallySignTransactionWithSigners([TEST_ORACLE], transaction);
  return getBase64EncodedWireTransaction(signed);
}

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function getGameManager(...args: Parameters<typeof GameManager.getInstance>): GameManager {
  const manager = GameManager.getInstance(...args);
  (manager as any).oracleClient.requireTokenPolicy = async (mint: string) => ({
    mint,
    enabled: true,
    minimumAmountRaw: "1",
    acceptedMinimumAmountRaw: "1",
    revision: 1,
    effectiveAt: "2026-09-02T00:00:00.000Z",
  });
  return manager;
}

function createConnectionStub(owner: PublicKey = TOKEN_PROGRAM_ID) {
  return {
    getAccountInfo: async () => ({ owner }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    }),
    // Individual rent tests provide a size-aware implementation. Other unit tests
    // use a nominal positive value so rent does not dominate their fixture balances.
    getMinimumBalanceForRentExemption: async (size: number) => (size === 0 ? 890_880 : 1),
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
      createGame: (cfg: any, _hash: any) => ({
        accounts: (accs: any) => {
          captures["createGameAccounts"] = accs;
          captures["createGameConfig"] = cfg;
          return {
            instruction: async () =>
              new TransactionInstruction({
                programId,
                keys: [
                  { pubkey: accs.game, isSigner: false, isWritable: true },
                  { pubkey: accs.creator, isSigner: true, isWritable: true },
                  { pubkey: accs.oracleOperator, isSigner: true, isWritable: false },
                ],
                data: Buffer.alloc(0),
              }),
          };
        },
      }),
      joinGame: () => ({
        accounts: (accs: any) => {
          captures["joinGameAccounts"] = accs;
          return {
            instruction: async () => {
              const instruction = new TransactionInstruction({
                programId,
                keys: [
                  { pubkey: accs.game, isSigner: false, isWritable: true },
                  { pubkey: accs.player, isSigner: true, isWritable: true },
                  {
                    pubkey: accs.oracleOperator ?? programId,
                    isSigner: Boolean(accs.oracleOperator),
                    isWritable: false,
                  },
                ],
                data: Buffer.alloc(0),
              });
              captures["joinGameInstruction"] = instruction;
              return instruction;
            },
          };
        },
      }),
    },
    account: {
      game: {
        fetch: async () => {
          const accounts = captures["createGameAccounts"];
          const config = captures["createGameConfig"];
          const funds = accounts.gameVaultCtx ?? accounts.gameTokenCtx;
          return {
            creator: accounts.creator,
            tokenMint: funds.tokenMint,
            gameType: config.gameType,
            ticketAmount: config.amount,
            totalAmount: config.amount,
            maxTickets: config.maxTickets,
            minTickets: config.minTickets,
          };
        },
      },
    },
  } as any;
}

function makeWallet(overrides: Record<string, any>) {
  const { connection: providedConnection, ...rest } = overrides;
  const connection = providedConnection ?? createConnectionStub();
  const wallet: any = {
    connection,
    getConnection: () => connection,
    getKeyPair: async (_: bigint) => await Keypair.generate(),
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toString(),
    ...rest,
  };

  wallet.connection = connection;
  if (!wallet.getConnection) {
    wallet.getConnection = () => connection;
  }
  wallet.getLatestBlockhash ??= async () => ({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1,
  });
  wallet.sendFullySignedGameTransaction ??= async (transaction: any) => {
    wallet.__lastGameTransaction = transaction;
    return wallet.sendTransaction?.([], []) ?? "SIG";
  };

  return wallet;
}

const makeSubmittedCreationHarness = async (sendError: unknown) => {
  const wallet = makeWallet({
    getTokenMetadata: async () => ({ decimals: 6 }),
    getTokenBalance: async () => 2_000_000,
    getBalance: async () => 3_000_000,
    sendFullySignedGameTransaction: vi.fn(async () => {
      throw sendError;
    }),
  });
  const finishPendingGameCreationSubmission = vi.fn(() => true);
  const db = {
    savePlayerMapping: () => {},
    saveGame: vi.fn(),
    saveGameParticipant: vi.fn(),
    savePendingGameCreation: vi.fn(),
    claimPendingGameCreationSubmission: vi.fn(() => ({ acquired: true })),
    finishPendingGameCreationSubmission,
    countActiveGamesByCreator: () => 0,
    countRecentGamesByCreator: () => 0,
  } as any;
  const program = makeProgram(wallet.connection);
  const gm = getGameManager(program, wallet, db);
  (gm as any).oracleClient = {
    requireTokenPolicy: async () => ({}),
    isHealthy: async () => true,
    generateGameSecrets: async () => ({
      randomHash: "f".repeat(64),
      oracleOperator: TEST_ORACLE.publicKey.toBase58(),
    }),
    signGameTransaction: signGameTransactionAsOracle,
    hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
  };
  (gm as any).resolveGameVaultAccounts = async () => ({
    tokenProgram: TOKEN_PROGRAM_ID,
    gameVault: (await Keypair.generate()).publicKey,
    gameVaultTokenAccount: (await Keypair.generate()).publicKey,
  });
  (gm as any).deriveAta = async () => (await Keypair.generate()).publicKey;
  (gm as any).confirmTransactionWithRecovery = async () => "SIG";
  return { gm, finishPendingGameCreationSubmission };
};

const attemptCreate = (gm: GameManager) =>
  gm.createGame(
    "coinflip",
    {
      amount: 1_000_000,
      tokenMint: PublicKey.default.toBase58(),
      tokenTicker: "TIMBA",
      isSol: false,
    },
    2,
    2,
    60,
    1n,
    { isPrivate: false },
    8200,
  );

describe("GameManager.createGame definitive failure classification", () => {
  afterEach(() => {
    resetGM();
  });

  const cases: Array<{ name: string; error: unknown; state: "failed" | "unknown" }> = [
    {
      name: "a plain string cause naming a program failure",
      error: Object.assign(new Error("send failed"), {
        cause: "Transaction simulation failed: custom program error: 0x1",
      }),
      state: "failed",
    },
    {
      name: "string log lines that report insufficient funds",
      error: Object.assign(new Error("send failed"), {
        logs: ["Program log: ok", "Program log: insufficient funds for rent"],
      }),
      state: "failed",
    },
    {
      name: "a transport error with no definitive marker",
      error: Object.assign(new Error("socket hang up"), { cause: "connection reset by peer" }),
      state: "unknown",
    },
  ];

  for (const { name, error, state } of cases) {
    test(`marks the submission ${state} for ${name}`, async () => {
      resetGM();
      const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { gm, finishPendingGameCreationSubmission } =
          await makeSubmittedCreationHarness(error);

        await attemptCreate(gm);

        expect(finishPendingGameCreationSubmission).toHaveBeenCalledTimes(1);
        const call = finishPendingGameCreationSubmission.mock.calls[0] as unknown[];
        expect(call[2]).toBe(state);
      } finally {
        errorSpy.mockRestore();
      }
    });
  }
});

describe("GameManager.createGame limit check error formatting", () => {
  afterEach(() => {
    resetGM();
  });

  test("falls back to the default friendly message when the error formatter itself fails", async () => {
    resetGM();
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const wallet = makeWallet({});
      const db = {
        hasGameCreationRequest: () => false,
        countActiveGamesByCreator: () => {
          throw new Error("synthetic database unavailable");
        },
        countRecentGamesByCreator: () => 0,
      };
      const gm = getGameManager(makeProgram(wallet.connection), wallet, db as any);
      const formatterFailure = new Error("connection lookup exploded");
      wallet.getConnection = () => {
        throw formatterFailure;
      };

      const result = await gm.createGame(
        "coinflip",
        { amount: 1000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
        2,
        2,
        60,
        1n,
        { replyToMessageId: 3 },
        2,
      );

      expect(result).toEqual({
        success: false,
        error: "❌ Something went wrong. Please try again in a moment.",
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to format user-friendly error for checking coinflip creation limits:",
        formatterFailure,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
