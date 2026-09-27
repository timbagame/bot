import { RpcRetryLaterError } from "../src/utils/rpc-request-budget";
import { getCreationRecoveryDelay } from "../src/utils/game-creation-recovery";
import { expect, test } from "bun:test";
import { Keypair, PublicKey, TransactionInstruction } from "#solana";
import {
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  partiallySignTransactionWithSigners,
} from "@solana/kit";
import {
  buildOracleSignableGameTransaction,
  decodeGameTransaction,
  finalizeOracleSignedGameTransaction,
} from "../src/utils/game-transaction";
import { GameManager } from "../src/utils/game";
import { GameDatabase } from "../src/utils/game-database";

async function fixture() {
  const creator = await Keypair.generate();
  const oracle = await Keypair.generate();
  const game = (await Keypair.generate()).publicKey.toBase58();
  const oldHash = (await Keypair.generate()).publicKey.toBase58();
  const newHash = (await Keypair.generate()).publicKey.toBase58();
  const prepared = await buildOracleSignableGameTransaction({
    creator,
    blockhash: { blockhash: oldHash, lastValidBlockHeight: 10 },
    instructions: [
      new TransactionInstruction({
        programId: PublicKey.default,
        keys: [
          { pubkey: creator.publicKey, isSigner: true, isWritable: true },
          { pubkey: oracle.publicKey, isSigner: true, isWritable: false },
          { pubkey: new PublicKey(game), isSigner: false, isWritable: true },
        ],
        data: Uint8Array.of(1, 2, 3),
      }),
    ],
  });
  const sign = async (wire: string) =>
    getBase64EncodedWireTransaction(
      await partiallySignTransactionWithSigners([oracle], decodeGameTransaction(wire)),
    );
  const original = await finalizeOracleSignedGameTransaction({
    creator,
    expectedMessageBytes: prepared.messageBytes,
    oracleSignedBase64: await sign(prepared.txBase64),
  });
  const db = GameDatabase.getInstance();
  db.savePendingGameCreation({
    gameAddress: game,
    creatorTelegramId: "1",
    amount: 1,
    gameType: "coinflip",
    tokenMint: PublicKey.default.toBase58(),
    tokenTicker: "TOK",
    maxPlayers: 2,
    minPlayers: 2,
    chatId: 1,
    timeoutSeconds: 3600,
    expiresAt: Date.now() + 3600000,
    transactionSignature: getSignatureFromTransaction(original),
    state: "unknown",
    transactionBlockhash: oldHash,
    lastValidBlockHeight: 10,
    signedTransactionBase64: getBase64EncodedWireTransaction(original),
  });
  let absent = true;
  let sends = 0;
  const wallet = {
    getConnection: () => ({ getBlockHeight: async () => 11 }),
    getTransactionOutcome: async () => "unknown",
    proveGameCreationAbsent: async () => absent,
    getKeyPair: async () => creator,
    getLatestBlockhash: async (fresh: boolean) => {
      expect(fresh).toBe(true);
      return { blockhash: newHash, lastValidBlockHeight: 200 };
    },
    sendFullySignedGameTransaction: async (tx: any) => {
      const signature = getSignatureFromTransaction(tx);
      const row = db.getPendingGameCreation(game)!;
      expect(row.transaction_signature).toBe(signature);
      expect(row.state).toBe("submitted");
      expect(row.signed_transaction_base64).toBe(getBase64EncodedWireTransaction(tx));
      const oldMessage = getCompiledTransactionMessageDecoder().decode(original.messageBytes);
      const newMessage = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      expect(newMessage).toEqual({ ...oldMessage, lifetimeToken: newHash });
      sends++;
      return signature;
    },
  };
  const manager = GameManager.getInstance(
    { account: { game: { fetchNullable: async () => null } } } as any,
    wallet as any,
    db,
  );
  (manager as any).oracleClient = { signGameTransaction: sign };
  return {
    manager,
    db,
    game,
    original,
    wallet,
    setAbsent: (v: boolean) => {
      absent = v;
    },
    sends: () => sends,
  };
}

test("recovery re-signs identical instructions and persists before broadcasting", async () => {
  const f = await fixture();
  await expect(
    f.manager.recoverPendingGameCreation({ api: {} } as any, f.db.getPendingGameCreation(f.game)!),
  ).rejects.toThrow("safely refreshed");
  expect(f.sends()).toBe(1);
  expect(f.db.getPendingGameCreation(f.game)!.transaction_signature).not.toBe(
    getSignatureFromTransaction(f.original),
  );
});

test("inconclusive history never creates or broadcasts a fresh transaction", async () => {
  const f = await fixture();
  f.setAbsent(false);
  await expect(
    f.manager.recoverPendingGameCreation({ api: {} } as any, f.db.getPendingGameCreation(f.game)!),
  ).rejects.toThrow("manual reconciliation");
  expect(f.sends()).toBe(0);
  expect(f.db.getPendingGameCreation(f.game)!.transaction_signature).toBe(
    getSignatureFromTransaction(f.original),
  );
});

test("definitive failure placeholder is retried after Telegram failure", async () => {
  const f = await fixture();
  f.db.setPendingCreationMessage(f.game, 88);
  f.db.setPendingGameCreationState(f.game, "failed");
  const row = f.db.getPendingGameCreation(f.game)!;
  await expect(
    f.manager.recoverPendingGameCreation(
      {
        api: {
          editMessageText: async () => {
            throw new Error("Telegram unavailable");
          },
        },
      } as any,
      row,
    ),
  ).rejects.toThrow("Telegram unavailable");
  expect(
    f.db.getPendingGameCreations(Date.now() + 900_000).some((p) => p.game_address === f.game),
  ).toBe(true);
  const edits: unknown[][] = [];
  await f.manager.recoverPendingGameCreation(
    {
      api: {
        editMessageText: async (...args: unknown[]) => {
          edits.push(args);
        },
      },
    } as any,
    row,
  );
  expect(edits).toEqual([[1, 88, "❌ Game creation failed. Please try again."]]);
  expect(f.db.getPendingGameCreation(f.game)).toBeNull();
});

test("a stale RPC blockhash does not consume the one automatic replacement", async () => {
  const f = await fixture();
  const old = f.db.getPendingGameCreation(f.game)!;
  f.wallet.getLatestBlockhash = async () => ({
    blockhash: new PublicKey(old.transaction_blockhash!).toBase58(),
    lastValidBlockHeight: old.last_valid_block_height!,
  });
  await expect(f.manager.recoverPendingGameCreation({ api: {} } as any, old)).rejects.toThrow(
    "fresh game transaction lifetime",
  );
  expect(f.sends()).toBe(0);
  expect(f.db.getPendingGameCreation(f.game)!.replacement_count).toBe(0);
});

test("a second proven-absent attempt resolves failure without a third charge attempt", async () => {
  const f = await fixture();
  await expect(
    f.manager.recoverPendingGameCreation({ api: {} } as any, f.db.getPendingGameCreation(f.game)!),
  ).rejects.toThrow("safely refreshed");
  f.wallet.getConnection = () => ({ getBlockHeight: async () => 201 });
  expect(
    await f.manager.recoverPendingGameCreation(
      { api: {} } as any,
      f.db.getPendingGameCreation(f.game)!,
    ),
  ).toBe(true);
  expect(f.sends()).toBe(1);
  expect(f.db.getPendingGameCreationForCreator("1")?.game_address).not.toBe(f.game);
});

test("an acknowledged failure edit remains idempotent after a lost Telegram response", async () => {
  const f = await fixture();
  f.db.setPendingCreationMessage(f.game, 89);
  f.db.setPendingGameCreationState(f.game, "failed");
  expect(
    await f.manager.recoverPendingGameCreation(
      {
        api: {
          editMessageText: async () => {
            throw new Error("message is not modified");
          },
        },
      } as any,
      f.db.getPendingGameCreation(f.game)!,
    ),
  ).toBe(true);
  expect(f.db.getPendingGameCreation(f.game)).toBeNull();
});

test("an old request proven failed edits its placeholder before any cleanup", async () => {
  const f = await fixture();
  (f.db as any).run(
    "UPDATE pending_game_creations SET created_at = ?, expires_at = ?, creation_message_id = 88 WHERE game_address = ?",
    [Date.now() - 181_000, Date.now() - 1_000, f.game],
  );
  const calls: string[] = [];
  const ctx = {
    api: {
      deleteMessage: async () => calls.push("delete"),
      editMessageText: async () => calls.push("failure"),
    },
  };
  expect(
    await f.manager.recoverPendingGameCreation(ctx as any, f.db.getPendingGameCreation(f.game)!),
  ).toBe(true);
  expect(calls).toEqual(["failure"]);
  expect(f.db.getPendingGameCreation(f.game)).toBeNull();
});

test("a replacement of an old request resets durable retry timing and fences stale backoff", async () => {
  const f = await fixture();
  (f.db as any).run(
    "UPDATE pending_game_creations SET created_at = ?, attempts = 10 WHERE game_address = ?",
    [Date.now() - 181_000, f.game],
  );
  const snapshot = f.db.getPendingGameCreation(f.game)!;
  await expect(f.manager.recoverPendingGameCreation({ api: {} } as any, snapshot)).rejects.toThrow(
    "safely refreshed",
  );
  const current = f.db.getPendingGameCreation(f.game)!;
  expect(current.replacement_count).toBe(1);
  expect(current.attempts).toBe(1);
  expect(current.created_at).toBe(snapshot.created_at);
  expect(getCreationRecoveryDelay(current)).toBe(3_000);
  f.db.recordPendingGameCreationAttempt(
    f.game,
    "stale",
    Date.now() + 900_000,
    Date.now(),
    snapshot.transaction_signature,
  );
  expect(f.db.getPendingGameCreation(f.game)!.attempts).toBe(1);
  const reopened = new (GameDatabase as any)();
  expect(getCreationRecoveryDelay(reopened.getPendingGameCreation(f.game))).toBe(3_000);
});

test("a cancelled foreground rebroadcast cannot admit a send after a slow height read", async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: (height: number) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const height = new Promise<number>((resolve) => {
    release = resolve;
  });
  f.wallet.getConnection = () => ({
    getBlockHeight: async () => {
      entered();
      return height;
    },
  });
  const controller = new AbortController();
  const attempt = (f.manager as any).rebroadcastPendingGameCreation(
    f.db.getPendingGameCreation(f.game),
    controller.signal,
  );
  await started;
  controller.abort();
  release(1);
  await expect(attempt).rejects.toThrow();
  expect(f.sends()).toBe(0);
  expect(f.db.getPendingGameCreation(f.game)!.state).toBe("unknown");
});

test("interactive recovery persists continuation and startup preserves cooldown", async () => {
  const f = await fixture();
  f.db.recordPendingGameCreationAttempt(f.game, "old backoff", Date.now() + 900000);
  const retryAt = Date.now() + 30000;
  f.wallet.proveGameCreationAbsent = async () => {
    throw new RpcRetryLaterError("checkpointed", retryAt);
  };
  await expect(
    f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game),
  ).rejects.toThrow("checkpointed");
  expect(f.db.getPendingGameCreation(f.game)?.next_attempt_at).toBe(retryAt);
  const reopened = new (GameDatabase as any)() as GameDatabase;
  reopened.resumeGameCreationRecovery();
  expect(reopened.getPendingGameCreation(f.game)?.next_attempt_at).toBe(retryAt);
  expect(await f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game)).toBe(
    false,
  );
});

test("startup advances legacy backoff and recovery eventually pauses without discarding evidence", async () => {
  const f = await fixture();
  const now = Date.now();
  f.db.recordPendingGameCreationAttempt(f.game, "old backoff", now + 900000);
  f.db.resumeGameCreationRecovery(now);
  expect(f.db.getPendingGameCreation(f.game)?.next_attempt_at).toBe(now);
  (f.db as any).run(
    "UPDATE pending_game_creations SET recovery_started_at = ? WHERE game_address = ?",
    [now - 900001, f.game],
  );
  await expect(
    f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game),
  ).rejects.toThrow("window ended");
  const row = f.db.getPendingGameCreation(f.game)!;
  expect(row.recovery_paused_at).toBeGreaterThan(0);
  expect(row.state).toBe("unknown");
  expect(row.signed_transaction_base64).toBeTruthy();
  f.db.resumeGameCreationRecovery();
  expect(
    f.db.getPendingGameCreations(Date.now() + 3600000).some((p) => p.game_address === f.game),
  ).toBe(false);
  expect(await f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game)).toBe(
    false,
  );
});

test("request receipts survive clearing and do not block other messages or chats", async () => {
  const f = await fixture();
  (f.db as any).run("INSERT INTO game_creation_requests VALUES (?, ?, ?, ?)", [
    "1",
    42,
    100,
    f.game,
  ]);
  expect(f.manager.hasGameCreationRequest(1n, 42, 100)).toBe(true);
  expect(f.manager.hasGameCreationRequest(1n, 42, 101)).toBe(false);
  expect(f.manager.hasGameCreationRequest(1n, 43, 100)).toBe(false);
  f.db.clearPendingGameCreation(f.game);
  const reopened = new (GameDatabase as any)() as GameDatabase;
  expect(reopened.hasGameCreationRequest("1", 42, 100)).toBe(true);
});

test("an unrelated pending game does not block a new creation request", async () => {
  const f = await fixture();
  const originalCount = f.db.countActiveGamesByCreator;
  let reachedCreationChecks = false;
  f.db.countActiveGamesByCreator = () => {
    reachedCreationChecks = true;
    throw new Error("reached normal creation checks");
  };
  try {
    const admissionResult = await f.manager.createGame(
      "coinflip",
      { amount: 1, tokenMint: PublicKey.default.toBase58(), tokenTicker: "TOK", isSol: false },
      2,
      2,
      3600,
      1n,
      { replyToMessageId: 101 },
      42,
    );
    expect(reachedCreationChecks).toBe(true);
    expect(admissionResult.success).toBe(false);
    expect(admissionResult.error).toBeTruthy();
    (f.db as any).run("INSERT INTO game_creation_requests VALUES (?, ?, ?, ?)", [
      "1",
      42,
      101,
      f.game,
    ]);
    const result = await f.manager.createGame(
      "coinflip",
      { amount: 1, tokenMint: PublicKey.default.toBase58(), tokenTicker: "TOK", isSol: false },
      2,
      2,
      3600,
      1n,
      { replyToMessageId: 101 },
      42,
    );
    expect(result.error).toContain("already been submitted");
  } finally {
    f.db.countActiveGamesByCreator = originalCount;
  }
});

test("foreground ownership prevents recovery and concurrent recovery shares one attempt", async () => {
  const f = await fixture();
  const internal = f.manager as any;
  let attempts = 0;
  let release!: () => void;
  const original = internal.recoverPendingGameCreationAttempt;
  internal.recoverPendingGameCreationAttempt = async () => {
    attempts++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return true;
  };
  try {
    internal.foregroundCreationGames.add(f.game);
    expect(await f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game)).toBe(
      false,
    );
    expect(attempts).toBe(0);
    internal.foregroundCreationGames.delete(f.game);
    const first = f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game);
    const second = f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game);
    expect(attempts).toBe(1);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(internal.recoveryFlights.size).toBe(0);
  } finally {
    internal.recoverPendingGameCreationAttempt = original;
    internal.foregroundCreationGames.delete(f.game);
  }
});

test("confirmed delivery gets a separate bounded window and upgrade resumes old delivery pauses", async () => {
  const f = await fixture();
  const now = Date.now();
  (f.db as any).run(
    "UPDATE pending_game_creations SET state = 'confirmed', recovery_started_at = ?, recovery_paused_at = ? WHERE game_address = ?",
    [now - 1800000, now - 1000, f.game],
  );
  f.db.resumeGameCreationRecovery(now);
  expect(f.db.getPendingGameCreation(f.game)?.recovery_paused_at).toBeNull();
  const internal = f.manager as any;
  const original = internal.recoverPendingGameCreationAttempt;
  let attempts = 0;
  internal.recoverPendingGameCreationAttempt = async () => {
    attempts++;
    throw new Error("Telegram unavailable");
  };
  try {
    await expect(
      f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game),
    ).rejects.toThrow("Telegram unavailable");
    expect(attempts).toBe(1);
    expect(f.db.getPendingGameCreation(f.game)?.recovery_paused_at).toBeNull();
    (f.db as any).run(
      "UPDATE pending_game_creations SET delivery_recovery_started_at = ? WHERE game_address = ?",
      [now - 3600001, f.game],
    );
    await expect(
      f.manager.recoverPendingGameCreationByAddress({ api: {} } as any, f.game),
    ).rejects.toThrow("Delivery recovery window ended");
    expect(attempts).toBe(1);
    f.db.resumeGameCreationRecovery();
    expect(f.db.getPendingGameCreation(f.game)?.recovery_paused_at).toBeGreaterThan(0);
  } finally {
    internal.recoverPendingGameCreationAttempt = original;
  }
});
