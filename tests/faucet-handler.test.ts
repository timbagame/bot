import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import { buildFaucetMessage, createFaucetModule } from "../src/handlers/faucet";
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
    parseResult?: any;
    editError?: () => unknown;
    answerCallback?: false;
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
      editMessageText: async (_chat: number, _message: number, text: string, editOptions: any) => {
        const failure = options.editError?.();
        if (failure) throw failure;
        events.push("edit");
        edits.push({ text, options: editOptions });
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
    parseAmount: async (args) =>
      options.parseResult ?? {
        success: true,
        data: options.parse?.(args) ?? parsed,
      },
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
    answerCallback:
      options.answerCallback === false
        ? undefined
        : async (_ctx, text) => {
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
    callbacks,
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
    expect(harness.replies.some(({ text }) => text.includes("confirmation is delayed"))).toBe(
      false,
    );
    expect(harness.answers.at(-1)).toBe("");
    await harness.module.reconcile();
    expect(db.getClaim(1, 20n)?.status).toBe("paid");
    expect(harness.transferSenders).toEqual([10n]);
    expect(harness.privateMessages).toHaveLength(1);
    expect(harness.privateMessages[0]?.chatId).toBe(20);
  });

  test("keeps an unknown submitted claim locked beyond the old timeout", async () => {
    let currentTime = 1_000;
    let outcome: "confirmed" | "failed" | "unknown" = "unknown";
    const harness = createHarness({
      now: () => currentTime,
      transfer: async (onPrepared) => {
        onPrepared("ambiguous-signature");
        throw new Error("confirmation timeout");
      },
      outcome: async () => outcome,
    });

    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);
    currentTime += 10 * 60_000;
    await harness.module.reconcile();

    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "submitted",
      transaction_signature: "ambiguous-signature",
    });
    await harness.module.handleClaim(harness.callbackContext(20), 1);
    expect(harness.transferSenders).toEqual([10n]);

    outcome = "confirmed";
    await harness.module.reconcile();
    expect(db.getClaim(1, 20n)?.status).toBe("paid");
  });

  test("does not let reconciliation release a claim while its transfer is in flight", async () => {
    let currentTime = 1_000;
    let releaseBalance!: () => void;
    let claimBalance = false;
    const harness = createHarness({
      now: () => currentTime,
      getBalance: () =>
        claimBalance
          ? new Promise<number>((resolve) => {
              releaseBalance = () => resolve(10_000);
            })
          : Promise.resolve(10_000),
    });

    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    claimBalance = true;
    const claimPromise = harness.module.handleClaim(harness.callbackContext(20), 1);
    await Promise.resolve();
    currentTime += 10 * 60_000;
    await harness.module.reconcile();
    expect(db.getClaim(1, 20n)?.status).toBe("processing");

    releaseBalance();
    await claimPromise;
    expect(db.getClaim(1, 20n)?.status).toBe("paid");
    expect(harness.transferSenders).toEqual([10n]);
  });

  test("coalesces overlapping reconciliation runs", async () => {
    let resolveOutcome!: () => void;
    const outcome = new Promise<"unknown">((resolve) => {
      resolveOutcome = () => resolve("unknown");
    });
    let outcomeCalls = 0;
    const harness = createHarness({
      outcome: async () => {
        outcomeCalls += 1;
        return outcome;
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));

    // Seed a submitted claim without going through the direct transfer path.
    db.reserveClaim(1, 20n, 1_000);
    db.recordClaimSignature(1, 20n, "submitted-signature", 1_001);
    const first = harness.module.reconcile();
    const second = harness.module.reconcile();
    resolveOutcome();
    await Promise.all([first, second]);

    expect(outcomeCalls).toBe(1);
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

describe("faucet handler edge cases", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  test("shows usage when no amount is given", async () => {
    const harness = createHarness();

    await harness.module.handleCommand(harness.commandContext("/faucet"));

    expect(harness.replies[0]?.text).toStartWith("Usage: <code>/faucet &lt;amount&gt;");
    expect(db.getFaucet(1)).toBeNull();
  });

  test("ignores commands without a resolvable creator or chat", async () => {
    const harness = createHarness();
    const ctx = harness.commandContext("/faucet 1 2");
    ctx.chat = undefined;

    await harness.module.handleCommand(ctx);

    expect(harness.replies).toEqual([]);
  });

  test("reports an amount that cannot be parsed", async () => {
    const harness = createHarness({ parseResult: { success: false, error: "invalid_amount" } });

    await harness.module.handleCommand(harness.commandContext("/faucet nope"));

    expect(harness.replies).toEqual([{ text: "invalid amount", options: { parse_mode: "HTML" } }]);
  });

  test("rejects a claim count above the limit", async () => {
    const harness = createHarness();

    await harness.module.handleCommand(harness.commandContext("/faucet 1 101"));

    expect(harness.replies[0]?.text).toStartWith("❌ Faucet ");
    expect(db.getFaucet(1)).toBeNull();
  });

  test("cancels the new faucet when its message cannot be posted", async () => {
    const harness = createHarness();
    const ctx = harness.commandContext("/faucet 1 2");
    ctx.reply = async () => {
      throw new Error("bot was kicked");
    };

    await expect(harness.module.handleCommand(ctx)).rejects.toThrow("bot was kicked");
    expect(db.getFaucet(1)?.status).toBe("cancelled");
  });

  test("registered callbacks route claims and cancellations by faucet id", async () => {
    const harness = createHarness();
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    const claim = harness.callbacks.get("^faucet:claim:(\\d+)$")!;
    const cancel = harness.callbacks.get("^faucet:cancel:(\\d+)$")!;

    await claim({ ...harness.callbackContext(20), match: ["faucet:claim:1", "1"] });
    expect(db.getClaim(1, 20n)?.status).toBe("paid");

    await cancel({ ...harness.callbackContext(10), match: ["faucet:cancel:1", "1"] });
    expect(db.getFaucet(1)?.status).toBe("cancelled");
  });

  test("answers callbacks directly when no answer helper is injected", async () => {
    const harness = createHarness({ answerCallback: false });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    const answers: unknown[] = [];
    const ctx = harness.callbackContext(11);
    ctx.answerCallbackQuery = async (payload?: unknown) => {
      answers.push(payload);
    };

    await harness.module.handleCancel(ctx, 1);
    const creator = harness.callbackContext(10);
    creator.answerCallbackQuery = async (payload?: unknown) => {
      answers.push(payload);
    };
    await harness.module.handleCancel(creator, 1);

    expect(answers[0]).toEqual({
      text: expect.stringContaining("Only the faucet creator"),
      show_alert: true,
    });
    expect(answers[1]).toEqual({ text: "Faucet cancelled.", show_alert: undefined });
  });

  test("an unchanged faucet message is not an error", async () => {
    const harness = createHarness();
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    const ctx = harness.callbackContext(10);
    ctx.api.editMessageText = async () => {
      throw new Error("Bad Request: message is not modified");
    };

    await expect(harness.module.handleCancel(ctx, 1)).resolves.toBeUndefined();
  });

  test("reconciliation fails a submitted claim whose transaction failed", async () => {
    const harness = createHarness({
      transfer: async (onPrepared) => {
        onPrepared("failed-signature");
        throw new Error("confirmation timeout");
      },
      outcome: async () => "failed",
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);

    expect(await harness.module.reconcile()).toBe(1);
    expect(db.getClaim(1, 20n)).toMatchObject({
      status: "failed",
      last_error: "submitted transaction failed",
    });
    expect(harness.edits.at(-1)?.text).toContain("Collected by: <b>0/1 users</b>");
  });

  test("reconciliation skips claims whose outcome cannot be read", async () => {
    const harness = createHarness({
      transfer: async (onPrepared) => {
        onPrepared("sig");
        throw new Error("confirmation timeout");
      },
      outcome: async () => {
        throw new Error("rpc down");
      },
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);

    expect(await harness.module.reconcile()).toBe(0);
    expect(db.getClaim(1, 20n)?.status).toBe("submitted");
    expect(warnSpy.mock.calls.at(-1)?.[0]).toBe("Failed to reconcile faucet claim 1:");
  });

  test("reconciliation keeps going when the faucet message cannot be updated", async () => {
    let failEdits = false;
    const harness = createHarness({
      transfer: async (onPrepared) => {
        onPrepared("sig");
        throw new Error("confirmation timeout");
      },
      outcome: async () => "confirmed",
      editError: () => (failEdits ? new Error("chat not found") : undefined),
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 1"));
    await harness.module.handleClaim(harness.callbackContext(20), 1);
    failEdits = true;

    expect(await harness.module.reconcile()).toBe(1);
    expect(db.getClaim(1, 20n)?.status).toBe("paid");
    expect(
      warnSpy.mock.calls.some(
        (call: unknown[]) => call[0] === "Failed to update reconciled faucet 1:",
      ),
    ).toBe(true);
    expect(harness.privateMessages).toHaveLength(1);
  });

  test("expireDue closes overdue faucets and refreshes their messages", async () => {
    let currentTime = 1_000;
    const harness = createHarness({ now: () => currentTime });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));

    expect(await harness.module.expireDue()).toBe(0);
    currentTime += 25 * 60 * 60 * 1_000;
    expect(await harness.module.expireDue()).toBe(1);

    expect(db.getFaucet(1)?.status).toBe("expired");
    expect(harness.edits.at(-1)?.text).toContain("⌛ Expired");
    expect(harness.edits.at(-1)?.options.reply_markup.inline_keyboard.flat()).toEqual([]);
  });

  test("expireDue still expires faucets whose message cannot be edited", async () => {
    let currentTime = 1_000;
    const harness = createHarness({
      now: () => currentTime,
      editError: () => new Error("message to edit not found"),
    });
    await harness.module.handleCommand(harness.commandContext("/faucet 1 2"));
    currentTime += 25 * 60 * 60 * 1_000;

    expect(await harness.module.expireDue()).toBe(1);
    expect(db.getFaucet(1)?.status).toBe("expired");
    expect(warnSpy.mock.calls.at(-1)?.[0]).toBe("Failed to update expired faucet 1:");
  });
});

describe("buildFaucetMessage", () => {
  const faucet = {
    id: 1,
    creator_id: "10",
    chat_id: "-100",
    message_id: 5,
    creator_display_name: "@creator",
    token_mint: "mint",
    token_ticker: "TOK",
    decimals: 2,
    is_sol: 0,
    amount_per_claim: "100",
    max_claims: 30,
    display_amount: "1 TOK",
    status: "active",
    created_at: 0,
    expires_at: 1,
  } as const;

  test("lists at most twenty collectors and counts the rest", () => {
    const collectors = Array.from({ length: 22 }, (_, index) => ({
      telegramId: String(index + 1),
      displayName: index === 0 ? "<b>bold</b>" : null,
    }));

    const text = buildFaucetMessage({ faucet, paidClaims: 22, processingClaims: 0, collectors });

    expect(text).toContain('<a href="tg://user?id=1">&lt;b&gt;bold&lt;/b&gt;</a>');
    expect(text).toContain('<a href="tg://user?id=2">User 2</a>');
    expect(text).not.toContain("User 21");
    expect(text).toContain(", +2 more");
    expect(text).toContain("Remaining: <b>8/30 TOK</b>");
  });

  test("does not link collectors without a numeric id", () => {
    const text = buildFaucetMessage({
      faucet,
      paidClaims: 1,
      processingClaims: 0,
      collectors: [{ telegramId: "legacy", displayName: "Old" }],
    });

    expect(text).toContain("Collectors: Old");
    expect(text).not.toContain("tg://user?id=legacy");
  });

  test("an empty faucet shows nothing remaining", () => {
    const text = buildFaucetMessage({
      faucet: { ...faucet, status: "empty" },
      paidClaims: 3,
      processingClaims: 0,
      collectors: [],
    });

    expect(text).toContain("Remaining: <b>0/30 TOK</b>");
    expect(text).toContain("🚰 Empty");
    expect(text).not.toContain("Collectors:");
  });
});
