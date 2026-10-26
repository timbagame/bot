import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { getBase64EncodedWireTransaction, partiallySignTransactionWithSigners } from "@solana/kit";
import { GameManager } from "../src/utils/game";
import { Keypair, PublicKey, TransactionInstruction } from "#solana";
import { TOKEN_PROGRAM_ID } from "#token";
import { PDAManager } from "../src/utils/pda";
import { decodeGameTransaction } from "../src/utils/game-transaction";
import { getCachedPriceLookup } from "../src/utils/price-service";
import { WSOL_MINT } from "../src/utils/constants";

const TEST_ORACLE = await Keypair.generate();
const FIXED_PDA = new PublicKey("11111111111111111111111111111111");
const AMOUNT = 1_000_000;

async function signAsOracle(txBase64: string): Promise<string> {
  const signed = await partiallySignTransactionWithSigners(
    [TEST_ORACLE],
    decodeGameTransaction(txBase64),
  );
  return getBase64EncodedWireTransaction(signed);
}

function makeProgram(connection: any, accountOverrides: Record<string, unknown> = {}) {
  const programId = new PublicKey("BPFLoader1111111111111111111111111111111111");
  const captures: any = {};
  return {
    programId,
    provider: { connection },
    __captures: captures,
    methods: {
      createGame: (cfg: any) => ({
        accounts: (accs: any) => {
          captures.accounts = accs;
          captures.config = cfg;
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
        accounts: (accs: any) => ({
          instruction: async () =>
            new TransactionInstruction({
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
            }),
        }),
      }),
    },
    account: {
      game: {
        fetch: async () => {
          const funds = captures.accounts.gameVaultCtx ?? captures.accounts.gameTokenCtx;
          return {
            creator: captures.accounts.creator,
            tokenMint: funds.tokenMint,
            gameType: captures.config.gameType,
            ticketAmount: captures.config.amount,
            totalAmount: captures.config.amount,
            maxTickets: captures.config.maxTickets,
            minTickets: captures.config.minTickets,
            ...accountOverrides,
          };
        },
      },
    },
  } as any;
}

type Harness = {
  gm: any;
  db: any;
  wallet: any;
  sendFullySigned: ReturnType<typeof vi.fn>;
};

type SetupOptions = {
  db?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
  account?: Record<string, unknown>;
  tokenBalance?: number;
  solBalance?: number;
  gm?: Record<string, unknown>;
  confirm?: () => Promise<string>;
};

let originalGetGamePda: unknown;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  originalGetGamePda = (PDAManager as any).getGamePDA;
  (PDAManager as any).getGamePDA = () => FIXED_PDA;
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  GameManager.resetForTest();
});

afterEach(() => {
  (PDAManager as any).getGamePDA = originalGetGamePda;
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  GameManager.resetForTest();
});

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const connection = {
    getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    }),
    getMinimumBalanceForRentExemption: async (size: number) => (size === 0 ? 890_880 : 1),
  } as any;
  const sendFullySigned = vi.fn(async () => "SIG");
  const wallet: any = {
    connection,
    getConnection: () => connection,
    getKeyPair: async () => await Keypair.generate(),
    getTokenMetadata: async () => ({ decimals: 6 }),
    getTokenBalance: async () => options.tokenBalance ?? 2_000_000,
    getBalance: async () => options.solBalance ?? 3_000_000,
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toString(),
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1,
    }),
    sendFullySignedGameTransaction: sendFullySigned,
    ...options.wallet,
  };
  // Fill defaults into the caller's object so tests can keep asserting on their own handle.
  const db: any = options.db ?? {};
  const dbDefaults: Record<string, unknown> = {
    savePlayerMapping: () => {},
    saveGame: vi.fn(),
    saveGameParticipant: vi.fn(),
    countActiveGamesByCreator: () => 0,
    countRecentGamesByCreator: () => 0,
  };
  for (const [key, value] of Object.entries(dbDefaults)) {
    if (!(key in db)) db[key] = value;
  }
  const program = makeProgram(connection, options.account);
  const gm: any = GameManager.getInstance(program, wallet, db);
  gm.oracleClient = {
    requireTokenPolicy: async () => ({}),
    isHealthy: async () => true,
    generateGameSecrets: async () => ({
      randomHash: "f".repeat(64),
      oracleOperator: TEST_ORACLE.publicKey.toBase58(),
    }),
    signGameTransaction: signAsOracle,
    hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
  };
  gm.feeBudget = { getGameSafetyBufferLamports: async () => 800_000 };
  gm.getGameCreationRentLamports = async () => 0;
  gm.getNativeWalletReserveLamports = async () => 0;
  gm.resolveGameVaultAccounts = async () => ({
    tokenProgram: TOKEN_PROGRAM_ID,
    gameVault: (await Keypair.generate()).publicKey,
    gameVaultTokenAccount: (await Keypair.generate()).publicKey,
  });
  gm.deriveAta = async () => (await Keypair.generate()).publicKey;
  gm.confirmTransactionWithRecovery = options.confirm ?? (async () => "CONFIRMED_SIG");
  Object.assign(gm, options.gm);
  return { gm, db, wallet, sendFullySigned };
}

function create(
  gm: any,
  overrides: {
    gameType?: "coinflip" | "giveaway";
    parsed?: Record<string, unknown>;
    options?: Record<string, unknown>;
    chatId?: number | undefined;
    timeout?: number;
  } = {},
) {
  return gm.createGame(
    overrides.gameType ?? "coinflip",
    {
      amount: AMOUNT,
      tokenMint: PublicKey.default.toBase58(),
      tokenTicker: "TIMBA",
      isSol: false,
      ...overrides.parsed,
    },
    2,
    2,
    overrides.timeout ?? 60,
    1n,
    { isPrivate: false, ...overrides.options },
    "chatId" in overrides ? overrides.chatId : 8300,
  );
}

const durableDb = (extra: Record<string, unknown> = {}): any => ({
  savePendingGameCreation: vi.fn(),
  claimPendingGameCreationSubmission: vi.fn(() => ({ acquired: true })),
  finishPendingGameCreationSubmission: vi.fn(() => true),
  ...extra,
});

describe("createGame early guards", () => {
  test("rejects a native SOL stake that was not explicitly requested as native", async () => {
    const { gm, wallet } = await setup();
    const getKeyPair = vi.spyOn(wallet, "getKeyPair");
    const result = await create(gm, { parsed: { isSol: true, requestedNativeSol: false } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Native SOL games must be routed through WSOL");
    expect(getKeyPair).not.toHaveBeenCalled();
  });

  test("rejects a request that is already being handled", async () => {
    const { gm, wallet } = await setup();
    const getKeyPair = vi.spyOn(wallet, "getKeyPair");
    gm.activeCreationRequestKeys.add("1:8300:55");
    const result = await create(gm, { options: { replyToMessageId: 55 } });
    expect(result).toEqual({
      success: false,
      error: "This game request is already being handled.",
    });
    expect(getKeyPair).not.toHaveBeenCalled();
    // The in-flight request that owns the key is left untouched.
    expect(gm.activeCreationRequestKeys.has("1:8300:55")).toBe(true);
  });
});

describe("createGame pending-creation persistence", () => {
  test("records the creation message against the prepared pending record", async () => {
    const setPendingCreationMessage = vi.fn();
    const db = durableDb({ setPendingCreationMessage });
    const { gm } = await setup({ db });
    const result = await create(gm, { options: { creationMessageId: 4242 } });
    expect(result.success).toBe(true);
    expect(setPendingCreationMessage).toHaveBeenCalledWith(FIXED_PDA.toBase58(), 4242);
  });

  test("writes the confirmed state conditionally and survives a failing state write", async () => {
    const setPendingGameCreationStateIfCurrent = vi.fn(() => {
      throw new Error("synthetic state write failure");
    });
    const db = durableDb({ setPendingGameCreationStateIfCurrent });
    const { gm } = await setup({ db });
    const result = await create(gm);
    expect(result.success).toBe(true);
    expect(setPendingGameCreationStateIfCurrent).toHaveBeenCalledTimes(1);
    const [address, expected, state, extra] = (setPendingGameCreationStateIfCurrent.mock.calls[0] ??
      []) as unknown[] as [string, string[], string, Record<string, unknown>];
    expect(address).toBe(FIXED_PDA.toBase58());
    expect(expected).toEqual(["submitted", "unknown", "confirmed"]);
    expect(state).toBe("confirmed");
    expect(extra).toMatchObject({
      clearSubmissionLease: true,
      expectedSignature: expect.any(String),
    });
    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to update pending game creation state for ${FIXED_PDA.toBase58()}`,
      expect.objectContaining({ message: "synthetic state write failure" }),
    );
  });

  test("falls back to the plain state setter and logs when it throws", async () => {
    const setPendingGameCreationState = vi.fn(() => {
      throw new Error("synthetic setter failure");
    });
    const db = durableDb({ setPendingGameCreationState });
    const { gm } = await setup({ db });
    const result = await create(gm);
    expect(result.success).toBe(true);
    expect(setPendingGameCreationState).toHaveBeenCalledWith(
      FIXED_PDA.toBase58(),
      "confirmed",
      expect.objectContaining({ error: null }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to update pending game creation state for ${FIXED_PDA.toBase58()}`,
      expect.objectContaining({ message: "synthetic setter failure" }),
    );
  });

  test("rewrites the whole record on older databases and logs when that fails", async () => {
    let writes = 0;
    const savePendingGameCreation = vi.fn((input: { state: string }) => {
      writes += 1;
      if (writes > 1) throw new Error(`synthetic rewrite failure for ${input.state}`);
    });
    const db = durableDb({ savePendingGameCreation });
    const { gm } = await setup({ db });
    const result = await create(gm);
    expect(result.success).toBe(true);
    expect(savePendingGameCreation).toHaveBeenCalledTimes(2);
    expect(savePendingGameCreation).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "confirmed" }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to update pending game creation for ${FIXED_PDA.toBase58()}`,
      expect.objectContaining({ message: "synthetic rewrite failure for confirmed" }),
    );
  });

  test("keeps the unknown state when confirmation fails after broadcast", async () => {
    const setPendingGameCreationState = vi.fn();
    const db = durableDb({ setPendingGameCreationState });
    const { gm } = await setup({
      db,
      confirm: async () => {
        throw new Error("synthetic confirmation failure");
      },
    });
    const result = await create(gm);
    expect(result).toEqual({
      success: false,
      gameAddress: FIXED_PDA.toBase58(),
      confirmedSignature: expect.any(String),
    });
    expect(setPendingGameCreationState).toHaveBeenCalledWith(
      FIXED_PDA.toBase58(),
      "unknown",
      expect.objectContaining({ error: "synthetic confirmation failure" }),
    );
    expect(db.saveGame).not.toHaveBeenCalled();
  });

  test("leaves a replaced intent to its durable worker instead of hydrating it", async () => {
    const db = durableDb({
      getPendingGameCreation: () => ({ transaction_signature: "REPLACEMENT_SIG" }),
    });
    const { gm } = await setup({ db });
    const result = await create(gm);
    expect(result).toEqual({
      success: false,
      gameAddress: FIXED_PDA.toBase58(),
      confirmedSignature: "REPLACEMENT_SIG",
    });
    expect(db.saveGame).not.toHaveBeenCalled();
    expect(db.saveGameParticipant).not.toHaveBeenCalled();
  });
});

describe("createGame submission admission", () => {
  test("refuses to broadcast when the intent was never durably prepared", async () => {
    const db = durableDb();
    const { gm, sendFullySigned } = await setup({ db });
    const result = await create(gm, { chatId: undefined });
    expect(result.success).toBe(false);
    expect(db.savePendingGameCreation).not.toHaveBeenCalled();
    expect(db.claimPendingGameCreationSubmission).not.toHaveBeenCalled();
    expect(sendFullySigned).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to finish confirmed game creation",
      expect.objectContaining({ gameAddress: FIXED_PDA.toBase58() }),
      expect.objectContaining({
        message: "Game creation intent was not durably prepared before broadcast",
      }),
    );
  });

  test("fails closed when the database persists intents but cannot admit a submission", async () => {
    const db = durableDb({ claimPendingGameCreationSubmission: undefined });
    const { gm, sendFullySigned } = await setup({ db });
    const result = await create(gm);
    expect(result.success).toBe(false);
    expect(db.savePendingGameCreation).toHaveBeenCalledTimes(1);
    expect(sendFullySigned).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to finish confirmed game creation",
      expect.anything(),
      expect.objectContaining({ message: "Durable game submission admission is unavailable" }),
    );
  });

  test("treats a double that loses its persistence writer after preparing as having no durable obligation", async () => {
    const db: any = durableDb({ claimPendingGameCreationSubmission: undefined });
    db.savePendingGameCreation = vi.fn(() => {
      // Simulates a database double whose pending writer is gone by admission time.
      delete db.savePendingGameCreation;
    });
    const { gm, sendFullySigned } = await setup({ db });
    const result = await create(gm);
    expect(result.success).toBe(true);
    expect(sendFullySigned).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      { acquired: false, reason: "lease_held" },
      "Game creation submission was not admitted (lease_held)",
    ],
    [undefined, "Game creation submission was not admitted (unavailable)"],
  ])("does not broadcast when admission is denied (%p)", async (claim, message) => {
    const db = durableDb({ claimPendingGameCreationSubmission: vi.fn(() => claim) });
    const { gm, sendFullySigned } = await setup({ db });
    const result = await create(gm);
    expect(result.success).toBe(false);
    expect(sendFullySigned).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to finish confirmed game creation",
      expect.anything(),
      expect.objectContaining({ message }),
    );
  });

  test("never writes an unconditional state after a send when the lease cannot be finished", async () => {
    const setPendingGameCreationState = vi.fn();
    const db = durableDb({
      finishPendingGameCreationSubmission: undefined,
      setPendingGameCreationState,
    });
    const { gm } = await setup({ db });
    const result = await create(gm);
    expect(result.success).toBe(true);
    const states = setPendingGameCreationState.mock.calls.map((call) => (call as unknown[])[1]);
    expect(states).toEqual(["confirmed"]);
  });

  test("reports a thrown lease finish and keeps the creation recoverable", async () => {
    const finishPendingGameCreationSubmission = vi.fn(() => {
      throw new Error("synthetic finish failure");
    });
    const db = durableDb({ finishPendingGameCreationSubmission });
    const { gm } = await setup({ db });
    const result = await create(gm);
    // The broadcast still succeeded, so the foreground creation completes.
    expect(result.success).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to finish pending game creation submission for ${FIXED_PDA.toBase58()}`,
      expect.objectContaining({ message: "synthetic finish failure" }),
    );
  });
});

describe("createGame funding checks", () => {
  test("warns about pending deposits when a wrapped SOL stake is still short", async () => {
    const { gm } = await setup({
      gm: {
        ensureWrappedSolBalance: async () => ({
          success: true,
          tokenBalance: AMOUNT - 1,
          solBalance: 3_000_000,
        }),
      },
    });
    const result = await create(gm, {
      parsed: { tokenMint: WSOL_MINT, tokenTicker: "WSOL", isSol: true, requestedNativeSol: true },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not enough WSOL");
    expect(result.error).toContain("wait for confirmation before trying again");
  });

  test("explains the shortfall when the balance only covers the stake", async () => {
    const swap = vi.fn();
    const { gm } = await setup({
      tokenBalance: AMOUNT,
      solBalance: 100_000,
      gm: { swapManager: { performJustInTimeSolSwap: swap } },
    });
    const result = await create(gm);
    expect(result.success).toBe(false);
    expect(result.error).toContain("You need about");
    expect(result.error).toContain("Your 1 TIMBA balance only covers the stake");
    expect(result.error).toContain("Add SOL or create a smaller game.");
    expect(swap).not.toHaveBeenCalled();
  });

  test("reports when the swap leaves too few tokens for the stake", async () => {
    let tokenCalls = 0;
    const { gm, sendFullySigned } = await setup({
      solBalance: 100_000,
      wallet: {
        getTokenBalance: async () => {
          tokenCalls += 1;
          return tokenCalls === 1 ? AMOUNT + 5_000 : AMOUNT - 5_000;
        },
      },
      gm: {
        swapManager: { performJustInTimeSolSwap: async () => ({ swapped: true }) },
      },
    });
    const result = await create(gm);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Swap completed but only 0.995 TIMBA remain, which is below the required 1. Please top up your tokens and try again.",
    );
    expect(sendFullySigned).not.toHaveBeenCalled();
  });

  test("reports when the swap still leaves too little SOL", async () => {
    const getBalance = vi.fn(async (_id: bigint, opts?: { forceFresh?: boolean }) =>
      opts?.forceFresh ? 200_000 : 100_000,
    );
    const { gm, sendFullySigned } = await setup({
      tokenBalance: AMOUNT + 500_000,
      wallet: { getBalance },
      gm: {
        swapManager: { performJustInTimeSolSwap: async () => ({ swapped: true }) },
      },
    });
    const result = await create(gm);
    expect(result.success).toBe(false);
    expect(result.error).toContain("You need about 0.0006 SOL more to create this game.");
    expect(getBalance).toHaveBeenLastCalledWith(1n, { forceFresh: true });
    expect(sendFullySigned).not.toHaveBeenCalled();
  });
});

describe("createGame confirmed-account verification", () => {
  const mismatch = (message: string, account: Record<string, unknown> | (() => any)) =>
    [message, account] as const;

  test.each([
    mismatch("Confirmed game creator does not match the requesting wallet", {
      creator: { equals: () => false },
    }),
    mismatch("Confirmed game token mint does not match the requested token", {
      tokenMint: { equals: () => false },
    }),
    mismatch("Confirmed game account does not match the requested configuration", {
      maxTickets: 9,
    }),
    mismatch("Confirmed game timeout does not match the requested configuration", {
      timeout: 61,
    }),
    mismatch("Confirmed game visibility does not match the requested configuration", {
      isPrivate: true,
    }),
  ])("rejects hydration when %s", async (message, account) => {
    const setPendingGameCreationState = vi.fn();
    const db = durableDb({ setPendingGameCreationState });
    const { gm } = await setup({
      db,
      account: account as Record<string, unknown>,
    });
    // creator/tokenMint of the default account are real keys, so only override those fields.
    const result = await create(gm);
    expect(result).toEqual({
      success: false,
      gameAddress: FIXED_PDA.toBase58(),
      confirmedSignature: "CONFIRMED_SIG",
    });
    expect(db.saveGame).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to finish confirmed game creation",
      expect.anything(),
      expect.objectContaining({ message }),
    );
  });

  test("stores the on-chain creation timing and forwards it to the pending record", async () => {
    const setPendingGameCreationChainTiming = vi.fn();
    const db = durableDb({ setPendingGameCreationChainTiming });
    const { gm } = await setup({
      db,
      account: { createdAt: 1_700_000_000, timeout: 60 },
    });
    const result = await create(gm);
    expect(result.success).toBe(true);
    expect(setPendingGameCreationChainTiming).toHaveBeenCalledWith(
      FIXED_PDA.toBase58(),
      1_700_000_000_000,
      1_700_000_060_000,
      expect.any(Number),
    );
    const saveArgs = db.saveGame.mock.calls[0] as unknown[];
    expect(saveArgs.slice(-2)).toEqual([1_700_000_060_000, 1_700_000_000_000]);
  });

  test("remembers the price used for the stake against the new game", async () => {
    const mint = (await Keypair.generate()).publicKey.toBase58();
    const { gm } = await setup();
    const result = await create(gm, {
      parsed: { tokenMint: mint, priceLookup: { price: 0.25, identifier: "fake-price" } },
    });
    expect(result.success).toBe(true);
    expect(gm.gamePriceCache.get(FIXED_PDA.toBase58())).toMatchObject({
      price: 0.25,
      identifier: "fake-price",
      tokenMint: mint,
    });
    expect(getCachedPriceLookup({ tokenMint: mint })?.price).toBe(0.25);
  });

  test("caches the price against WSOL for native SOL stakes", async () => {
    const { gm } = await setup({
      gm: {
        ensureWrappedSolBalance: async () => ({
          success: true,
          tokenBalance: 2_000_000,
          solBalance: 3_000_000,
        }),
      },
    });
    const result = await create(gm, {
      parsed: {
        tokenMint: WSOL_MINT,
        tokenTicker: "WSOL",
        isSol: true,
        requestedNativeSol: true,
        priceLookup: { price: 150, identifier: "fake-sol" },
      },
    });
    expect(result.success).toBe(true);
    expect(gm.gamePriceCache.get(FIXED_PDA.toBase58())).toMatchObject({
      price: 150,
      tokenMint: WSOL_MINT,
    });
  });
});
