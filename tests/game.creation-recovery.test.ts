import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey, TransactionInstruction } from "#solana";
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransactionWithSigners,
} from "@solana/kit";
import {
  buildOracleSignableGameTransaction,
  decodeGameTransaction,
  finalizeOracleSignedGameTransaction,
} from "../src/utils/game-transaction";
import { GameManager } from "../src/utils/game";

const GAME = "BPFLoader1111111111111111111111111111111111";
const MINT = "So11111111111111111111111111111111111111112";

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  GameManager.resetForTest();
});

function makePending(overrides: Record<string, unknown> = {}): any {
  return {
    game_address: GAME,
    creator_telegram_id: "1",
    creator_display_name: "Alice",
    amount: 100,
    game_type: "coinflip",
    token_mint: MINT,
    token_ticker: "TOK",
    max_players: 2,
    min_players: 2,
    chat_id: 5,
    timeout_seconds: 3600,
    expires_at: Date.now() + 3_600_000,
    transaction_signature: "SIG",
    state: "submitted",
    is_private: null,
    transaction_blockhash: null,
    last_valid_block_height: null,
    signed_transaction_base64: null,
    reply_to_message_id: null,
    creation_message_id: null,
    replacement_count: 0,
    attempts: 0,
    last_error: null,
    next_attempt_at: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeManager(options: { db?: Record<string, unknown>; wallet?: Record<string, unknown> }) {
  return GameManager.getInstance(
    { account: { game: { fetch: async () => ({}) } } } as any,
    (options.wallet ?? {}) as any,
    (options.db ?? {}) as any,
  );
}

function makeCtx(chatId = 5) {
  const calls: any[][] = [];
  const ctx = {
    chat: { id: chatId },
    api: {
      deleteMessage: async (...args: any[]) => {
        calls.push(["delete", ...args]);
      },
      editMessageText: async (...args: any[]) => {
        calls.push(["edit", ...args]);
      },
    },
  } as any;
  return { ctx, calls };
}

describe("deliverPendingGameCreation", () => {
  function setup(db: Record<string, unknown>, gm?: Record<string, unknown>) {
    const manager = makeManager({ db });
    const created: any[][] = [];
    (manager as any).createGameMessage = async (...args: any[]) => {
      created.push(args);
      return 42;
    };
    Object.assign(manager as any, gm ?? {});
    return { manager, created };
  }

  test("resolves the creator name from the stored creator public key", async () => {
    const lookups: any[][] = [];
    const { manager, created } = setup({
      getGameMessages: () => [],
      getCreatorInfo: (address: string) => ({ publicKey: `pk-of-${address}` }),
    });
    (manager as any).getPlayerUsername = async (...args: any[]) => {
      lookups.push(args);
      return "@alice";
    };
    const { ctx } = makeCtx();

    await (manager as any).deliverPendingGameCreation(
      ctx,
      makePending({ creator_display_name: null }),
      { status: "active", game_type: "coinflip", amount: 100, token_ticker: "TOK" },
    );

    expect(lookups).toHaveLength(1);
    expect(lookups[0]![1]).toBe(`pk-of-${GAME}`);
    expect(created[0]![4]).toBe("@alice");
    expect(created[0]![6]).toBe("Active");
  });

  test("keeps Unknown when the database has no creator info helper or key", async () => {
    const withoutHelper = setup({ getGameMessages: () => [] });
    const withoutKey = setup({ getGameMessages: () => [], getCreatorInfo: () => ({}) });
    const { ctx } = makeCtx();

    for (const { manager, created } of [withoutHelper, withoutKey]) {
      await (manager as any).deliverPendingGameCreation(
        ctx,
        makePending({ creator_display_name: null }),
        { status: "active" },
      );
      expect(created[0]![4]).toBe("Unknown");
    }
  });

  test("warns and keeps Unknown when the creator lookup fails", async () => {
    const failure = new Error("lookup failed");
    const { manager, created } = setup({
      getGameMessages: () => [],
      getCreatorInfo: () => ({ publicKey: "pk" }),
    });
    (manager as any).getPlayerUsername = async () => {
      throw failure;
    };
    const { ctx } = makeCtx();

    await (manager as any).deliverPendingGameCreation(
      ctx,
      makePending({ creator_display_name: null }),
      { status: "active" },
    );

    expect(created[0]![4]).toBe("Unknown");
    expect(warnSpy).toHaveBeenCalledWith(
      `Failed to resolve creator for recovered game ${GAME}:`,
      failure,
    );
  });

  test("delivers terminal games as Completed with the winner and pot", async () => {
    const { manager, created } = setup({ getGameMessages: () => [] });
    const { ctx } = makeCtx();

    await (manager as any).deliverPendingGameCreation(ctx, makePending(), {
      status: "cancelled",
      winner_address: "cancelled",
      total_amount: 77,
    });

    expect(created[0]![6]).toBe("Completed");
    expect(created[0]![8]).toEqual({
      reserveDelivery: true,
      winnerAddress: "cancelled",
      totalPot: 77,
    });
  });

  test("fails when another delivery already holds the reservation", async () => {
    const { manager } = setup({ getGameMessages: () => [] });
    (manager as any).createGameMessage = async () => 0;
    const { ctx, calls } = makeCtx();

    await expect(
      (manager as any).deliverPendingGameCreation(ctx, makePending({ creation_message_id: 9 }), {
        status: "active",
      }),
    ).rejects.toThrow("game message delivery is already in flight");
    expect(calls).toEqual([]);
  });

  test("only finishes the placeholder when the origin chat already has the card", async () => {
    const { manager, created } = setup({
      getGameMessages: () => [{ chat_id: 5, message_id: 11 }],
    });
    const { ctx, calls } = makeCtx();

    await (manager as any).deliverPendingGameCreation(
      ctx,
      makePending({ creation_message_id: 9 }),
      { status: "active" },
    );

    expect(created).toEqual([]);
    expect(calls).toEqual([["delete", 5, 9]]);
  });
});

describe("isPendingGameCreationLifetimeExpired", () => {
  test("treats invalid lifetimes and missing connections as not expired", async () => {
    const noConnection = makeManager({ wallet: {} });
    for (const lastValid of [-1, 1.5, Number.NaN, "abc"]) {
      expect(
        await (noConnection as any).isPendingGameCreationLifetimeExpired(
          makePending({ last_valid_block_height: lastValid }),
        ),
      ).toBe(false);
    }
    expect(
      await (noConnection as any).isPendingGameCreationLifetimeExpired(
        makePending({ last_valid_block_height: 10 }),
      ),
    ).toBe(false);
  });

  test("compares the finalized block height to the stored lifetime", async () => {
    const heights: Array<number | bigint> = [11, 10, 9n as unknown as number];
    const manager = makeManager({
      wallet: { getConnection: () => ({ getBlockHeight: async () => heights.shift() }) },
    });
    const pending = makePending({ last_valid_block_height: 10 });

    expect(await (manager as any).isPendingGameCreationLifetimeExpired(pending)).toBe(true);
    expect(await (manager as any).isPendingGameCreationLifetimeExpired(pending)).toBe(false);
    expect(await (manager as any).isPendingGameCreationLifetimeExpired(pending)).toBe(false);
  });
});

describe("rebroadcastPendingGameCreation", () => {
  async function signedFixture() {
    const creator = await Keypair.generate();
    const oracle = await Keypair.generate();
    const gameKey = (await Keypair.generate()).publicKey;
    const blockhash = (await Keypair.generate()).publicKey.toBase58();
    const prepared = await buildOracleSignableGameTransaction({
      creator,
      blockhash: { blockhash, lastValidBlockHeight: 10 },
      instructions: [
        new TransactionInstruction({
          programId: PublicKey.default,
          keys: [
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: oracle.publicKey, isSigner: true, isWritable: false },
            { pubkey: gameKey, isSigner: false, isWritable: true },
          ],
          data: Uint8Array.of(1, 2, 3),
        }),
      ],
    });
    const oracleSigned = getBase64EncodedWireTransaction(
      await partiallySignTransactionWithSigners([oracle], decodeGameTransaction(prepared.txBase64)),
    );
    const signed = await finalizeOracleSignedGameTransaction({
      creator,
      expectedMessageBytes: prepared.messageBytes,
      oracleSignedBase64: oracleSigned,
    });
    return {
      wire: getBase64EncodedWireTransaction(signed),
      signature: getSignatureFromTransaction(signed),
      blockhash,
    };
  }

  function db(overrides: Record<string, unknown> = {}) {
    const finishes: any[][] = [];
    const claims: any[][] = [];
    return {
      finishes,
      claims,
      db: {
        claimPendingGameCreationSubmission: (...args: any[]) => {
          claims.push(args);
          return { acquired: true };
        },
        finishPendingGameCreationSubmission: (...args: any[]) => {
          finishes.push(args);
        },
        ...overrides,
      },
    };
  }

  const wallet = (send: (...args: any[]) => Promise<string>, height = 5) => ({
    getConnection: () => ({ getBlockHeight: async () => height }),
    sendFullySignedGameTransaction: send,
  });

  test("rejects a pending row without a reusable signed transaction lifetime", async () => {
    const manager = makeManager({ db: db().db, wallet: wallet(async () => "x") });
    for (const overrides of [
      { signed_transaction_base64: null, transaction_blockhash: "h", last_valid_block_height: 1 },
      { signed_transaction_base64: "w", transaction_blockhash: null, last_valid_block_height: 1 },
      { signed_transaction_base64: "w", transaction_blockhash: "h", last_valid_block_height: -1 },
    ]) {
      await expect(
        (manager as any).rebroadcastPendingGameCreation(makePending(overrides)),
      ).rejects.toThrow("pending game creation has no reusable signed transaction lifetime");
    }
  });

  test("refuses to send once the confirmed height passed the lifetime", async () => {
    const sent: unknown[] = [];
    const manager = makeManager({
      db: db().db,
      wallet: wallet(async (...args) => {
        sent.push(args);
        return "x";
      }, 11),
    });

    await expect(
      (manager as any).rebroadcastPendingGameCreation(
        makePending({
          signed_transaction_base64: "w",
          transaction_blockhash: "h",
          last_valid_block_height: 10,
        }),
      ),
    ).rejects.toThrow("Game transaction is no longer broadcastable; awaiting finalized expiry");
    expect(sent).toEqual([]);
  });

  test("requires durable submission admission support", async () => {
    const manager = makeManager({ db: {}, wallet: wallet(async () => "x") });
    await expect(
      (manager as any).rebroadcastPendingGameCreation(
        makePending({
          signed_transaction_base64: "w",
          transaction_blockhash: "h",
          last_valid_block_height: 10,
        }),
      ),
    ).rejects.toThrow("Durable game submission admission is unavailable");
  });

  for (const [label, claim, message] of [
    [
      "in flight",
      { acquired: false, reason: "in-flight" },
      `Pending game creation submission is already in flight; keeping ${GAME} reserved`,
    ],
    [
      "other reason",
      { acquired: false, reason: "lease-lost" },
      "Pending game creation submission was not admitted (lease-lost)",
    ],
    ["no answer", undefined, "Pending game creation submission was not admitted (unavailable)"],
  ] as const) {
    test(`reports a refused claim (${label})`, async () => {
      const sent: unknown[] = [];
      const manager = makeManager({
        db: db({ claimPendingGameCreationSubmission: () => claim }).db,
        wallet: wallet(async (...args) => {
          sent.push(args);
          return "x";
        }),
      });
      await expect(
        (manager as any).rebroadcastPendingGameCreation(
          makePending({
            signed_transaction_base64: "w",
            transaction_blockhash: "h",
            last_valid_block_height: 10,
          }),
        ),
      ).rejects.toThrow(message);
      expect(sent).toEqual([]);
    });
  }

  test("rebroadcasts the signed transaction and records the submitted state", async () => {
    const fixture = await signedFixture();
    const sends: any[][] = [];
    const { db: stubDb, finishes, claims } = db();
    const manager = makeManager({
      db: stubDb,
      wallet: wallet(async (...args) => {
        sends.push(args);
        return fixture.signature;
      }),
    });

    await (manager as any).rebroadcastPendingGameCreation(
      makePending({
        signed_transaction_base64: fixture.wire,
        transaction_blockhash: fixture.blockhash,
        last_valid_block_height: 10,
        transaction_signature: fixture.signature,
      }),
    );

    expect(sends).toHaveLength(1);
    expect(sends[0]![1]).toEqual({ blockhash: fixture.blockhash, lastValidBlockHeight: 10 });
    expect(sends[0]![2]).toBe(true);
    expect(claims[0]![0]).toBe(GAME);
    expect(claims[0]![4]).toBe(fixture.signature);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]![0]).toBe(GAME);
    expect(finishes[0]![2]).toBe("submitted");
    expect(finishes[0]![3].error).toBeNull();
  });

  test("keeps going when the submission state write fails after a good send", async () => {
    const fixture = await signedFixture();
    const stateError = new Error("db busy");
    const manager = makeManager({
      db: db({
        finishPendingGameCreationSubmission: () => {
          throw stateError;
        },
      }).db,
      wallet: wallet(async () => fixture.signature),
    });

    await (manager as any).rebroadcastPendingGameCreation(
      makePending({
        signed_transaction_base64: fixture.wire,
        transaction_blockhash: fixture.blockhash,
        last_valid_block_height: 10,
        transaction_signature: fixture.signature,
      }),
    );

    expect(errorSpy).toHaveBeenCalledWith(
      `Failed to finish pending game creation submission for ${GAME}`,
      stateError,
    );
  });

  test("marks the submission unknown when the send fails", async () => {
    const fixture = await signedFixture();
    const { db: stubDb, finishes } = db();
    const manager = makeManager({
      db: stubDb,
      wallet: wallet(async () => {
        throw new Error("rpc rejected");
      }),
    });

    await expect(
      (manager as any).rebroadcastPendingGameCreation(
        makePending({
          signed_transaction_base64: fixture.wire,
          transaction_blockhash: fixture.blockhash,
          last_valid_block_height: 10,
          transaction_signature: fixture.signature,
        }),
      ),
    ).rejects.toThrow("rpc rejected");
    expect(finishes[0]![2]).toBe("unknown");
    expect(finishes[0]![3].error).toBe("rpc rejected");
  });

  test("marks the submission unknown when the RPC returns a different signature", async () => {
    const fixture = await signedFixture();
    const { db: stubDb, finishes } = db();
    const manager = makeManager({ db: stubDb, wallet: wallet(async () => "OTHER_SIGNATURE") });

    await expect(
      (manager as any).rebroadcastPendingGameCreation(
        makePending({
          signed_transaction_base64: fixture.wire,
          transaction_blockhash: fixture.blockhash,
          last_valid_block_height: 10,
          transaction_signature: fixture.signature,
        }),
      ),
    ).rejects.toThrow(`Pending game rebroadcast returned an unexpected signature for ${GAME}`);
    expect(finishes[0]![2]).toBe("unknown");
  });

  test("stringifies non-Error failures and tolerates a missing finish helper", async () => {
    const fixture = await signedFixture();
    const { db: stubDb, finishes } = db();
    const manager = makeManager({
      db: stubDb,
      wallet: wallet(async () => {
        throw "plain failure";
      }),
    });
    const pending = makePending({
      signed_transaction_base64: fixture.wire,
      transaction_blockhash: fixture.blockhash,
      last_valid_block_height: 10,
      transaction_signature: fixture.signature,
    });

    await expect((manager as any).rebroadcastPendingGameCreation(pending)).rejects.toBe(
      "plain failure",
    );
    expect(finishes[0]![3].error).toBe("plain failure");

    const bare = makeManager({
      db: { claimPendingGameCreationSubmission: () => ({ acquired: true }) },
      wallet: wallet(async () => "OTHER"),
    });
    await expect((bare as any).rebroadcastPendingGameCreation(pending)).rejects.toThrow(
      /unexpected signature/,
    );
  });
});

describe("recovery placeholder cleanup after a failed attempt", () => {
  function setup(options: { deleteFails?: boolean; recentlyPrepared?: boolean }) {
    const record = makePending({
      creation_message_id: 77,
      transaction_prepared_at: Date.now() - (options.recentlyPrepared ? 1_000 : 200_000),
    });
    const scheduled: any[][] = [];
    const cleared: any[][] = [];
    const manager = makeManager({
      db: {
        getPendingGameCreation: () => record,
        scheduleGameCreationRecovery: (...args: any[]) => scheduled.push(args),
        setPendingCreationMessage: (...args: any[]) => cleared.push(args),
      },
    });
    const failure = new Error("attempt failed");
    (manager as any).recoverPendingGameCreationAttempt = async () => {
      throw failure;
    };
    const { ctx, calls } = makeCtx();
    if (options.deleteFails) {
      ctx.api.deleteMessage = async () => {
        throw new Error("cannot delete");
      };
    }
    return { manager, record, scheduled, cleared, failure, ctx, calls };
  }

  test("removes a long-unresolved placeholder and reports operator attention", async () => {
    const { manager, record, scheduled, cleared, ctx, calls } = setup({});

    await expect(manager.recoverPendingGameCreation(ctx, record)).rejects.toThrow("attempt failed");

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]![2]).toBe("attempt failed");
    expect(calls).toEqual([["delete", 5, 77]]);
    expect(cleared).toEqual([[GAME, null]]);
    expect(errorSpy).toHaveBeenCalledWith(
      `Game creation needs operator attention: ${GAME} (SIG); recovery is still pending`,
    );
  });

  test("warns and still surfaces the original failure when cleanup itself fails", async () => {
    const { manager, record, cleared, ctx } = setup({ deleteFails: true });

    await expect(manager.recoverPendingGameCreation(ctx, record)).rejects.toThrow("attempt failed");

    expect(cleared).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toBe("Unable to remove unresolved creation placeholder");
  });

  test("keeps a recently prepared placeholder in place", async () => {
    const { manager, record, cleared, ctx, calls } = setup({ recentlyPrepared: true });

    await expect(manager.recoverPendingGameCreation(ctx, record)).rejects.toThrow("attempt failed");

    expect(calls).toEqual([]);
    expect(cleared).toEqual([]);
  });
});
