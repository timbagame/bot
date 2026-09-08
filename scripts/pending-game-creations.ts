import { createHash } from "node:crypto";

import {
  GameDatabase,
  type PendingGameCreationRecord,
  type PendingGameCreationState,
} from "../src/utils/game-database";

const OPERATOR_RESOLVABLE_STATES = ["prepared", "submitted", "unknown", "confirmed"] as const;
type OperatorResolvableState = (typeof OPERATOR_RESOLVABLE_STATES)[number];

const isOperatorResolvableState = (value: string): value is OperatorResolvableState =>
  OPERATOR_RESOLVABLE_STATES.includes(value as OperatorResolvableState);

const wireDigest = (wire: string | null | undefined): string | null =>
  wire ? createHash("sha256").update(wire, "base64").digest("hex") : null;

const formatRecord = (record: PendingGameCreationRecord): Record<string, unknown> => ({
  gameAddress: record.game_address,
  creatorTelegramId: record.creator_telegram_id,
  amount: record.amount,
  gameType: record.game_type,
  tokenMint: record.token_mint,
  tokenTicker: record.token_ticker,
  maxPlayers: record.max_players,
  minPlayers: record.min_players,
  chatId: record.chat_id,
  timeoutSeconds: record.timeout_seconds,
  requestedExpiresAt: record.expires_at,
  transactionSignature: record.transaction_signature,
  state: record.state satisfies PendingGameCreationState,
  transactionBlockhash: record.transaction_blockhash,
  lastValidBlockHeight: record.last_valid_block_height,
  onChainCreatedAt: record.on_chain_created_at ?? null,
  signedTransactionPresent: Boolean(record.signed_transaction_base64),
  signedTransactionWireSha256: wireDigest(record.signed_transaction_base64),
  attempts: record.attempts,
  lastError: record.last_error,
  nextAttemptAt: record.next_attempt_at,
  submissionLeaseExpiresAt: record.submission_lease_expires_at ?? null,
  resolutionReason: record.resolution_reason ?? null,
  resolvedBy: record.resolved_by ?? null,
  resolvedAt: record.resolved_at ?? null,
  createdAt: record.created_at,
  updatedAt: record.updated_at,
});

export function listPendingGameCreations(gameAddress?: string): void {
  const records = GameDatabase.getInstance().getPendingGameCreationAuditRecords(gameAddress);
  if (records.length === 0) {
    console.log(
      gameAddress
        ? `No game creation intent found for ${gameAddress}.`
        : "No game creation intents found.",
    );
    return;
  }

  for (const record of records) {
    console.log(JSON.stringify(formatRecord(record), null, 2));
  }
}

const parseOption = (args: string[], option: string): string | undefined => {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

export function resolvePendingGameCreationCommand(args: string[]): void {
  const gameAddress = args[0];
  const expectedState = parseOption(args, "--state");
  const reason = parseOption(args, "--reason");
  const actor =
    parseOption(args, "--actor") ?? process.env["SERVICE_ADMIN_ACTOR"] ?? "service-admin";
  const confirmed = args.includes("--confirm");

  if (!gameAddress || !expectedState || !reason || !confirmed || args.some((arg) => arg === "--")) {
    throw new Error(
      "Usage: resolve-pending-game-creation <game_address> --state <prepared|submitted|unknown|confirmed> --confirm --reason <evidence> [--actor <operator>]",
    );
  }
  if (!isOperatorResolvableState(expectedState)) {
    throw new Error("--state must be prepared, submitted, unknown, or confirmed");
  }

  const database = GameDatabase.getInstance();
  const before = database.getPendingGameCreation(gameAddress);
  if (!before) {
    throw new Error(`No game creation intent found for ${gameAddress}`);
  }
  console.log("Current intent evidence:");
  console.log(JSON.stringify(formatRecord(before), null, 2));

  if (!isOperatorResolvableState(before.state)) {
    throw new Error(
      `Refusing operator resolution for ${gameAddress}: current state is ${before.state}; confirmed and delivered intents require normal recovery`,
    );
  }
  if (before.state !== expectedState) {
    throw new Error(
      `Refusing operator resolution for ${gameAddress}: expected ${expectedState}, found ${before.state}; inspect the current record and retry with the exact state`,
    );
  }

  if (
    before.state === "confirmed" &&
    (before.signed_transaction_base64 ||
      before.transaction_blockhash ||
      before.last_valid_block_height != null ||
      before.on_chain_created_at != null)
  ) {
    throw new Error(
      `Refusing operator resolution for ${gameAddress}: confirmed intent has reusable evidence; normal recovery must finish it`,
    );
  }

  const resolved = database.resolvePendingGameCreation(gameAddress, expectedState, reason, actor);
  if (!resolved) {
    throw new Error(
      `Pending game creation ${gameAddress} changed before operator resolution; no state was changed`,
    );
  }

  const after = database.getPendingGameCreation(gameAddress);
  console.log("Operator resolution recorded:");
  if (after) {
    console.log(JSON.stringify(formatRecord(after), null, 2));
  }
  console.log(`Creator lock released for ${gameAddress}; the audit row was retained.`);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "list-pending-game-creations") {
    listPendingGameCreations(process.argv[3]);
  } else if (command === "resolve-pending-game-creation") {
    resolvePendingGameCreationCommand(process.argv.slice(3));
  } else {
    throw new Error(
      "Usage: bun run scripts/pending-game-creations.ts <list-pending-game-creations|resolve-pending-game-creation> ...",
    );
  }
}
