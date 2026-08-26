import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { createFaucetModule } from "../src/handlers/faucet";
import { FaucetDatabase } from "../src/utils/faucet-database";
import { inferMaxPlayers } from "../src/utils/arg-parsing";
import { resetTestDatabase } from "./helpers/database";

let db: FaucetDatabase;
const publicKey = new PublicKey("11111111111111111111111111111111");

const parsed = {
  amount: 100,
  isSol: false,
  formattedAmount: "1 TOK",
  tokenMint: "mint",
  tokenTicker: "TOK",
  decimals: 2,
  tokenWasSpecified: false,
  requestedNativeSol: false,
};

const createHarness = (
  options: {
    parse?: (args: string[]) => any;
    balance?: number;
    getBalance?: () => Promise<number>;
    transfer?: (onPrepared: (signature: string) => void) => Promise<string>;
    outcome?: () => Promise<"confirmed" | "failed" | "unknown">;
    notify?: (chatId: number, text: string) => Promise<void>;
    now?: () => number;
  } = {},
) => {
  const callbacks = new Map<string, (ctx: any) => Promise<void>>();
  const replies: Array<{ text: string; options: any }> = [];
  const edits: Array<{ text: string; options: any }> = [];
  const answers: string[] = [];
  const transferSenders: bigint[] = [];
  const privateMessages: Array<{ chatId: number; text: string; options: any }> = [];
  const events: string[] = [];
  const bot = {
    api: {
      editMessageText: async (_chat: number, _message: number, text: string, options: any) => {
        events.push("edit");
        edits.push({ text, options });
      },
      sendMessage: async (chatId: number, text: string, messageOptions: any) => {
        events.push("dm");
        if (options.notify) await options.notify(chatId, text);
        privateMessages.push({ chatId, text, options: messageOptions });
        return { message_id: 999 };
      },
    },
    callbackQuery: (pattern: RegExp, handler: (ctx: any) => Promise<void>) => {
      callbacks.set(pattern.source, handler);
    },
  } as any;
  const module = createFaucetModule({
    bot,
    database: db,
    parseAmount: async (args) => ({
      success: true,
      data: options.parse?.(args) ?? parsed,
    }),
    inferMaxPlayers,
    getRequiredTelegramId: async () => 10n,
    getBalance: async () =>
      options.getBalance ? options.getBalance() : (options.balance ?? 10_000),
    getRecipientPublicKey: () => publicKey,
    transfer: async (creatorId, _recipient, _parsed, onPrepared) => {
      transferSenders.push(creatorId);
      if (options.transfer) return options.transfer(onPrepared);
      onPrepared("transaction-signature");
      return "transaction-signature";
    },
    getTransactionOutcome: options.outcome ?? (async () => "unknown"),
    isTransactionOutcomeUnknown: (error) =>
      error instanceof Error && error.message.includes("confirmation timeout"),
    formatAmountError: () => "invalid amount",
    now: options.now ?? (() => 1_000),
    answerCallback: async (_ctx, text) => {
      answers.push(text ?? "");
    },
  });
  module.registerCallbacks();

  const commandContext = (text: string) =>
    ({
      chat: { id: -100 },
      from: { id: 10, username: "creator" },
      message: { text },
      reply: async (replyText: string, replyOptions: any) => {
        replies.push({ text: replyText, options: replyOptions });
        return { message_id: 55 };
      },
      api: {},
    }) as any;
  const callbackContext = (userId: number) =>
    ({
      from: { id: userId, username: `collector${userId}` },
      callbackQuery: {
        id: `callback-${userId}`,
        message: { message_id: 55, chat: { id: -100 } },
      },
      api: {
        editMessageText: async (
          _chat: number,
          _message: number,
          text: string,
          editOptions: any,
        ) => {
          events.push("edit");
          edits.push({ text, options: editOptions });
        },
      },
      reply: async (replyText: string, replyOptions: any) => {
        replies.push({ text: replyText, options: replyOptions });
        return { message_id: 56 };
      },
    }) as any;

  return {
    module,
    replies,
    edits,
    answers,
    transferSenders,
    privateMessages,
    events,
    commandContext,
    callbackContext,
  };
};

beforeEach(() => {
  resetTestDatabase("faucets.sqlite");
  FaucetDatabase.resetForTesting();
  db = FaucetDatabase.getInstance();
});

afterEach(() => {
  try {
    (db as any).db.close();
  } catch {}
  FaucetDatabase.resetForTesting();
  resetTestDatabase("faucets.sqlite");
});

describe("faucet handler", () => {
  test.each([
    ["/faucet $1 4", "$1 worth of TOK", 4],
    ["/faucet 1 USD 4", "$1 worth of TOK", 4],
    ["/faucet 1 4", "1 TOK", 4],
    ["/faucet $1 WBTC 4", "$1 worth of TOK", 4],
    ["/faucet 1 WBTC 4", "1 TOK", 4],
  ])("accepts shared amount syntax: %s", async (command, display, claims) => {
    const explicitToken = command.includes("WBTC");
    const harness = createHarness({
      parse: () => ({ ...parsed, tokenWasSpecified: explicitToken || command.includes(" USD ") }),
    });
    await harness.module.handleCommand(harness.commandContext(command));
    const faucet = db.getFaucet(1);
    expect(faucet?.max_claims).toBe(claims);
    expect(faucet?.display_amount).toBe(display);
    expect(harness.replies.at(-1)?.text).toContain("Collected by: <b>0/4 users</b>");
  });

  test("rejects creation when existing faucets reserve the available balance", async () => {
    const harness = createHarness({ balance: 500 });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 4"));
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    expect(db.getFaucet(1)).not.toBeNull();
    expect(db.getFaucet(2)).toBeNull();
    expect(harness.replies.at(-1)?.text).toContain("Not enough TOK");
  });

  test("rejects creation when the creator cannot fund the full faucet", async () => {
    const harness = createHarness({ balance: 399 });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 4"));
    expect(db.getFaucet(1)).toBeNull();
    expect(harness.replies.at(-1)?.text).toContain("Not enough TOK");
  });

  test("does not create a faucet when balance verification is unavailable", async () => {
    const harness = createHarness({
      getBalance: async () => {
        throw new Error("RPC unavailable");
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 4"));

    expect(db.getFaucet(1)).toBeNull();
    expect(harness.replies.at(-1)?.text).toContain("Could not verify your balance");
  });

  test("rejects unsafe total multiplication", async () => {
    const harness = createHarness({
      parse: () => ({ ...parsed, amount: Number.MAX_SAFE_INTEGER }),
      balance: Number.MAX_SAFE_INTEGER,
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    expect(db.getFaucet(1)).toBeNull();
    expect(harness.replies.at(-1)?.text).toContain("total faucet amount is too large");
  });

  test("pays a unique claimant and updates the live progress", async () => {
    const harness = createHarness();
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);
    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "paid",
      transaction_signature: "transaction-signature",
    });
    expect(db.getFaucet(1)?.status).toBe("completed");
    expect(harness.transferSenders).toEqual([10n]);
    expect(harness.edits.at(-1)?.text).toContain("Collected by: <b>1/1 users</b>");
    expect(harness.edits.at(-1)?.text).toContain('<a href="tg://user?id=20">@collector20</a>');
    expect(harness.privateMessages).toEqual([
      expect.objectContaining({
        chatId: 20,
        text: expect.stringContaining("from <b>@creator</b>"),
      }),
    ]);
    expect(db.getClaim(1, 20n)?.notification_status).toBe("sent");
    expect(harness.events.slice(-2)).toEqual(["edit", "dm"]);
  });

  test("rejects creator claims and copied faucet buttons", async () => {
    const harness = createHarness();
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    await harness.module.handleClaim(harness.callbackContext(10), 1);
    expect(db.getClaim(1, 10n)).toBeNull();
    expect(harness.answers.at(-1)).toContain("cannot collect your own");

    const copiedContext = harness.callbackContext(20);
    copiedContext.callbackQuery.message.message_id = 999;
    await harness.module.handleClaim(copiedContext, 1);
    expect(db.getClaim(1, 20n)).toBeNull();
    expect(harness.answers.at(-1)).toContain("no longer valid");
  });

  test("releases a claim after transfer failure so it can be retried", async () => {
    let attempts = 0;
    const harness = createHarness({
      transfer: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary RPC failure");
        return "retry-signature";
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);
    expect(db.getClaim(1, 20n)?.status).toBe("failed");
    expect(harness.replies.at(-1)?.text).toContain("Payment failed");
    await harness.module.handleClaim(harness.callbackContext(20), 1);
    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "paid",
      transaction_signature: "retry-signature",
    });
  });

  test("closes an active faucet when the creator no longer has enough balance", async () => {
    let balance = 100;
    const harness = createHarness({
      balance,
      transfer: async () => {
        throw new Error("transfer should not be attempted");
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    balance = 0;
    const emptyHarness = createHarness({ balance });
    await emptyHarness.module.handleClaim(emptyHarness.callbackContext(20), 1);

    expect(db.getFaucet(1)?.status).toBe("empty");
    expect(db.getClaim(1, 20n)?.status).toBe("failed");
    expect(emptyHarness.replies.at(-1)?.text).toContain("faucet is empty");
    expect(emptyHarness.edits.at(-1)?.text).toContain("Empty");
    expect(emptyHarness.edits.at(-1)?.text).toContain("Remaining: <b>0/1 TOK</b>");
    expect(emptyHarness.edits.at(-1)?.options.reply_markup.inline_keyboard.flat()).toEqual([]);
  });

  test("closes the faucet when a transfer reports insufficient funds", async () => {
    const harness = createHarness({
      transfer: async () => {
        throw Object.assign(new Error("Transaction simulation failed"), {
          logs: ["Program log: Error: insufficient funds"],
        });
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);

    expect(db.getFaucet(1)?.status).toBe("empty");
    expect(db.getClaim(1, 20n)?.status).toBe("failed");
    expect(harness.replies.at(-1)?.text).toContain("faucet is empty");
  });

  test("keeps the faucet active when balance verification is unavailable", async () => {
    let balanceAvailable = true;
    const harness = createHarness({
      getBalance: async () => {
        if (!balanceAvailable) throw new Error("RPC unavailable");
        return 100;
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    balanceAvailable = false;
    await harness.module.handleClaim(harness.callbackContext(20), 1);

    expect(db.getFaucet(1)?.status).toBe("active");
    expect(db.getClaim(1, 20n)?.status).toBe("failed");
    expect(harness.replies.at(-1)?.text).toContain("Could not verify the faucet balance");
  });

  test("does not treat a bare custom program error as insufficient funds", async () => {
    const harness = createHarness({
      transfer: async () => {
        throw new Error("Transaction simulation failed: custom program error: 0x1");
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);

    expect(db.getFaucet(1)?.status).toBe("active");
    expect(db.getClaim(1, 20n)?.status).toBe("failed");
    expect(harness.replies.at(-1)?.text).toContain("Payment failed");
  });

  test("reconciles an ambiguous direct transfer without paying twice", async () => {
    const harness = createHarness({
      transfer: async (onPrepared) => {
        onPrepared("ambiguous-signature");
        throw new Error("confirmation timeout");
      },
      outcome: async () => "confirmed",
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);
    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "submitted",
      transaction_signature: "ambiguous-signature",
    });
    await harness.module.reconcile();
    expect(db.getClaim(1, 20n)?.status).toBe("paid");
    expect(harness.transferSenders).toEqual([10n]);
    expect(harness.privateMessages).toHaveLength(1);
    expect(harness.privateMessages[0]?.chatId).toBe(20);
  });

  test("keeps a confirmed faucet payment successful when private messaging is forbidden", async () => {
    const harness = createHarness({
      notify: async () => {
        throw Object.assign(new Error("bot was blocked"), {
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        });
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);

    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "paid",
      notification_status: "failed",
      notification_error: "bot was blocked",
    });
    expect(db.getFaucet(1)?.status).toBe("completed");
    expect(harness.edits.at(-1)?.text).toContain("Completed");
  });

  test("retries transient private notification failures without paying twice", async () => {
    let currentTime = 1_000;
    let notificationAttempts = 0;
    const harness = createHarness({
      now: () => currentTime,
      notify: async () => {
        notificationAttempts += 1;
        if (notificationAttempts === 1) throw new Error("temporary Telegram failure");
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);

    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "paid",
      notification_status: "pending",
      notification_attempts: 1,
      notification_next_attempt_at: 61_000,
    });
    expect(harness.privateMessages).toHaveLength(0);

    currentTime = 61_000;
    await harness.module.reconcile();

    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "paid",
      notification_status: "sent",
      notification_attempts: 1,
      notification_next_attempt_at: null,
    });
    expect(notificationAttempts).toBe(2);
    expect(harness.privateMessages).toHaveLength(1);
    expect(harness.transferSenders).toEqual([10n]);
  });

  test("stops retrying a private notification after five transient failures", async () => {
    let currentTime = 1_000;
    const originalWarn = console.warn;
    console.warn = () => {};
    const harness = createHarness({
      now: () => currentTime,
      notify: async () => {
        throw new Error("temporary Telegram failure");
      },
    });

    try {
      await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
      await harness.module.handleClaim(harness.callbackContext(20), 1);

      for (let attempt = 1; attempt < 5; attempt += 1) {
        currentTime = db.getClaim(1, 20n)?.notification_next_attempt_at ?? currentTime;
        await harness.module.reconcile();
      }

      expect(db.getClaim(1, 20n)).toMatchObject({
        status: "paid",
        notification_status: "failed",
        notification_attempts: 5,
        notification_next_attempt_at: null,
      });
      expect(harness.transferSenders).toEqual([10n]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("enforces creator-only cancellation", async () => {
    const harness = createHarness();
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    await harness.module.handleCancel(harness.callbackContext(11), 1);
    expect(db.getFaucet(1)?.status).toBe("active");
    expect(harness.answers.at(-1)).toContain("Only the faucet creator");
    await harness.module.handleCancel(harness.callbackContext(10), 1);
    expect(db.getFaucet(1)?.status).toBe("cancelled");
    expect(harness.edits.at(-1)?.text).toContain("Cancelled");
  });
});
