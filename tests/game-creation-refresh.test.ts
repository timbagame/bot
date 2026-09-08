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
  expect(f.db.getPendingGameCreations().some((p) => p.game_address === f.game)).toBe(true);
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
  expect(current.attempts).toBe(0);
  expect(current.created_at).toBe(snapshot.created_at);
  expect(getCreationRecoveryDelay(current)).toBe(3_000);
  f.db.recordPendingGameCreationAttempt(
    f.game,
    "stale",
    Date.now() + 900_000,
    Date.now(),
    snapshot.transaction_signature,
  );
  expect(f.db.getPendingGameCreation(f.game)!.attempts).toBe(0);
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
