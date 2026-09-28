import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "#solana";
import {
  bot,
  botModule,
  answers,
  buttons,
  failApiMethod,
  lastMessage,
  lastText,
  messageCalls,
  messageText,
  press,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  texts,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import { WSOL_MINT } from "../src/utils/constants";
import { clearAllInputSessions, storePendingTransaction } from "../src/utils/user-state";

useBotHarness();

// Each test uses a fresh user so the per-user wallet RPC budget never runs out.
let USER = 71_000;
let OTHER_USER = 81_000;
const TOKEN_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const LAMPORTS = 1_000_000_000;

let recipient: string;
let transfers: Array<{ kind: string; args: unknown[] }>;

let walletTokens: Array<{
  mint: string;
  ticker: string;
  balance: number;
  decimals: number;
  rawBalance: string;
}> = [];

const seedWallet = (
  overrides: { solBalance?: number; tokenBalance?: number; wsol?: number } = {},
) => {
  const tokenBalance = overrides.tokenBalance ?? 2_500_000;
  walletTokens = [
    {
      mint: TOKEN_MINT,
      ticker: "USDT",
      balance: tokenBalance,
      decimals: 6,
      rawBalance: String(tokenBalance),
    },
    ...(overrides.wsol
      ? [
          {
            mint: WSOL_MINT,
            ticker: "WSOL",
            balance: overrides.wsol,
            decimals: 9,
            rawBalance: String(overrides.wsol),
          },
        ]
      : []),
  ];
  botModule.__test_clearWalletCache(BigInt(USER));
  botModule.__test_setWalletCache(BigInt(USER), {
    solBalance: overrides.solBalance ?? 5 * LAMPORTS,
    tokenBalances: walletTokens,
  });
};

beforeAll(async () => {
  recipient = (await Keypair.generate()).publicKey.toBase58();
});

beforeEach(() => {
  USER += 1;
  OTHER_USER += 1;
  resetCalls();
  clearAllInputSessions();
  transfers = [];
  seedWallet();
  // Other suites replace wallet methods on the shared singleton; pin the ones these flows read.
  stub(wallet, "getAllWalletTokenBalances", async () => walletTokens);
  stub(wallet, "getBalance", async () => 5 * LAMPORTS);
  stub(wallet, "getTokenBalance", async () => 0);
  stub(wallet, "confirmTransaction", async (signature: string) => {
    transfers.push({ kind: "confirm", args: [signature] });
  });
  stub(wallet, "getTokenTransferSafety", async () => ({ warnings: [] }));
  stub(wallet, "transferSol", async (...args: unknown[]) => {
    transfers.push({ kind: "sol", args });
    return "sol-signature";
  });
  stub(wallet, "transferToken", async (...args: unknown[]) => {
    transfers.push({ kind: "token", args });
    return "token-signature";
  });
  stub(wallet, "withdrawAllSol", async (...args: unknown[]) => {
    transfers.push({ kind: "withdrawAll", args });
    return { signature: "max-signature", totalLamportsSent: 4 * LAMPORTS };
  });
});

afterEach(() => {
  restoreStubs();
  clearAllInputSessions();
});

/** Reply to the latest prompt the bot sent or edited. */
const replyToPrompt = async (text: string, userId = USER) => {
  const prompt = messageCalls()
    .filter((call) => /Reply to this message/.test(messageText(call)))
    .at(-1)!;
  const messageId = prompt.payload.message_id ?? 77;
  await sendText(text, { userId, chatId: USER, replyTo: messageId });
};

const confirmButton = (prefix: string) =>
  buttons(
    messageCalls()
      .filter((call) => buttons(call).some((button) => button.data?.startsWith(prefix)))
      .at(-1),
  ).find((button) => button.data.startsWith(prefix))!.data;

describe("send flow", () => {
  test("the withdraw menu lists SOL and wallet tokens", async () => {
    await press("cmd_withdraw", { userId: USER });
    expect(lastText()).toContain("Withdraw");
    const data = buttons(lastMessage()).map((button) => button.data);
    expect(data).toContain("send_select_SOL");
    expect(data).toContain(`send_select_${TOKEN_MINT}`);
  });

  test("selecting a token shows its balance and quick amounts", async () => {
    await press(`send_select_${TOKEN_MINT}`, { userId: USER });
    expect(lastText()).toContain("<b>Balance:</b> 2.5 USDT");
    const data = buttons(lastMessage()).map((button) => button.data);
    expect(data).toContain(`send_amount_${TOKEN_MINT}_50%`);
    expect(data).toContain(`send_amount_${TOKEN_MINT}_CUSTOM`);
    expect(answers()).toContain("Token selected");

    await press("send_select_SOL", { userId: USER });
    expect(lastText()).toContain("<b>Balance:</b> 5 SOL");
  });

  test("a percentage of SOL leads to address entry and a confirmed transfer", async () => {
    await press("send_amount_SOL_50%", { userId: USER });
    expect(lastText()).toContain("Send 50% (~");
    expect(lastText()).toContain("Enter destination address");

    await replyToPrompt(recipient);
    expect(lastText()).toContain("Send Confirmation");
    expect(lastText()).toContain(recipient);

    await press(confirmButton("confirm_send_"), { userId: USER });
    const sol = transfers.find((entry) => entry.kind === "sol")!;
    expect(sol.args[0]).toBe(BigInt(USER));
    expect(String(sol.args[1])).toBe(recipient);
    expect(Number(sol.args[2])).toBeGreaterThan(2 * LAMPORTS);
    expect(transfers.at(-1)).toEqual({ kind: "confirm", args: ["sol-signature"] });
    expect(lastText()).toContain("Transaction Completed");
    expect(answers()).toContain("✅ Transaction submitted");
  });

  test("MAX SOL withdraws the whole balance", async () => {
    await press("send_amount_SOL_MAX", { userId: USER });
    expect(lastText()).toContain("Send MAX (~");
    await replyToPrompt(recipient);
    await press(confirmButton("confirm_send_"), { userId: USER });
    expect(transfers[0]!.kind).toBe("withdrawAll");
    expect(lastText()).toContain("Sent 4 SOL");
  });

  test("MAX SOL that cannot cover fees reports a friendly error", async () => {
    stub(wallet, "withdrawAllSol", async () => ({ signature: "x", totalLamportsSent: 0 }));
    await press("send_amount_SOL_MAX", { userId: USER });
    await replyToPrompt(recipient);
    await press(confirmButton("confirm_send_"), { userId: USER });
    expect(answers()).toContain("❌ Send failed");
  });

  test("custom SOL amounts are checked against the fee buffer", async () => {
    await press("send_amount_SOL_CUSTOM", { userId: USER });
    expect(lastText()).toContain("Custom Amount - SOL");
    expect(answers()).toContain("Send the amount as a message");

    await replyToPrompt("1.5");
    expect(lastText()).toContain("Send 1.5 SOL");
    await replyToPrompt(recipient);
    stub(wallet, "getBalance", async () => LAMPORTS);
    await press(confirmButton("confirm_send_"), { userId: USER });
    expect(transfers.filter((entry) => entry.kind === "sol")).toHaveLength(0);
    expect(answers()).toContain("❌ Send failed");
  });

  test("token sends show transfer warnings and send raw token units", async () => {
    stub(wallet, "getTokenTransferSafety", async () => ({
      warnings: ["This token charges a transfer fee"],
    }));
    await press(`send_amount_${TOKEN_MINT}_CUSTOM`, { userId: USER });
    expect(lastText()).toContain("Custom Amount - USDT");
    await replyToPrompt("1.25");
    await replyToPrompt(recipient);
    expect(lastText()).toContain("⚠️ This token charges a transfer fee");
    await press(confirmButton("confirm_send_"), { userId: USER });
    const token = transfers.find((entry) => entry.kind === "token")!;
    expect(token.args[2]).toBe(1_250_000);
    expect(token.args[3]).toBe(TOKEN_MINT);
    expect(lastText()).toContain("Sent 1.25 ");
    expect(lastText()).toContain("Transaction Completed");
  });

  test("blocked tokens cannot be sent", async () => {
    stub(wallet, "getTokenTransferSafety", async () => ({
      warnings: [],
      blockedReason: "Token is frozen",
    }));
    await press(`send_amount_${TOKEN_MINT}_50%`, { userId: USER });
    await replyToPrompt(recipient);
    expect(lastText()).toContain("Error processing input");
  });

  test("MAX token sends use the full balance", async () => {
    await press(`send_amount_${TOKEN_MINT}_MAX`, { userId: USER });
    await replyToPrompt(recipient);
    await press(confirmButton("confirm_send_"), { userId: USER });
    expect(transfers.find((entry) => entry.kind === "token")!.args[2]).toBe(2_500_000);
  });

  test("token sends larger than the balance fail", async () => {
    await press(`send_amount_${TOKEN_MINT}_CUSTOM`, { userId: USER });
    await replyToPrompt("1");
    await replyToPrompt(recipient);
    seedWallet({ tokenBalance: 10 });
    await press(confirmButton("confirm_send_"), { userId: USER });
    expect(transfers.filter((entry) => entry.kind === "token")).toHaveLength(0);
    expect(answers()).toContain("❌ Send failed");
  });

  test("invalid addresses are rejected", async () => {
    await press("send_amount_SOL_25%", { userId: USER });
    await replyToPrompt("short");
    expect(lastText()).toContain("Error processing input");

    await press("send_amount_SOL_25%", { userId: USER });
    await replyToPrompt("0".repeat(44));
    expect(lastText()).toContain("Error processing input");
  });

  test("prompts are locked to the user who opened them", async () => {
    await press("send_amount_SOL_25%", { userId: USER });
    await replyToPrompt(recipient, OTHER_USER);
    expect(lastText()).toContain("This prompt is no longer active for you");
  });

  test("confirmations expire and belong to their creator", async () => {
    await press("confirm_send_missing", { userId: USER });
    expect(answers()).toContain("❌ Transaction expired or not found");

    await press("send_amount_SOL_25%", { userId: USER });
    await replyToPrompt(recipient);
    const confirm = confirmButton("confirm_send_");
    await press(confirm, { userId: OTHER_USER, chatId: USER });
    expect(answers()).toContain("❌ Unauthorized transaction");
  });

  test("unknown tokens and malformed selections are reported", async () => {
    await press("send_amount_UNKNOWN_50%", { userId: USER });
    expect(answers()).toContain("❌ Error processing amount");
    await press("send_amount_SOL", { userId: USER });
    expect(answers().at(-1)).toBe("❌ Error processing amount");
  });
});

describe("wrap and unwrap flows", () => {
  test("the wrap menu shows native SOL and WSOL balances", async () => {
    stub(wallet, "getTokenBalance", async () => 2 * LAMPORTS);
    await press("cmd_wrap", { userId: USER });
    expect(lastText()).toContain("<b>Native SOL:</b> 5");
    expect(lastText()).toContain("<b>WSOL:</b> 2");
    const data = buttons(lastMessage()).map((button) => button.data);
    expect(data).toContain("wrap_amount_50%");
    expect(data).toContain("wrap_custom");
  });

  test("quick wrap amounts ask for confirmation and then wrap", async () => {
    await press("wrap_amount_50%", { userId: USER });
    expect(lastText()).toContain("Wrap Confirmation");
    expect(lastText()).toContain("<b>Selection:</b> 50% of available SOL");

    const wraps: unknown[][] = [];
    stub(wallet, "wrapSol", async (...args: unknown[]) => {
      wraps.push(args);
      return "wrap-signature";
    });
    await press(confirmButton("confirm_wrap_"), { userId: USER });
    expect(wraps).toHaveLength(1);
    expect(texts().some((text) => text.includes("Wrapping"))).toBe(true);
    expect(lastText()).toContain("Wrap Completed");
    expect(answers().at(-1)).toContain("submitted");
  });

  test("wrapping more than the balance allows is refused", async () => {
    stub(wallet, "getBalance", async () => 1_000);
    await press(`confirm_wrap_${LAMPORTS}`, { userId: USER });
    expect(lastText()).toContain("Wrap Failed");
  });

  test("wrap failures and invalid amounts show an error", async () => {
    stub(wallet, "wrapSol", async () => {
      throw new Error("rpc down");
    });
    await press(`confirm_wrap_${LAMPORTS}`, { userId: USER });
    expect(texts().at(-1)).not.toContain("rpc down");

    await press("confirm_wrap_abc", { userId: USER });
    expect(answers().at(-1)).toBe("❌ Wrap failed");

    await press("wrap_amount_0", { userId: USER });
    expect(answers().at(-1)).toBe("❌ Error processing wrap amount");
  });

  test("custom wrap amounts are entered as a reply", async () => {
    await press("wrap_custom", { userId: USER });
    expect(lastText()).toContain("Custom Wrap Amount");
    await replyToPrompt("0.25");
    expect(lastText()).toContain("Wrap Confirmation");
    expect(lastText()).toContain("0.25");

    await press("wrap_custom", { userId: USER });
    await replyToPrompt("nope");
    expect(lastText()).toContain("Error processing input");
  });

  test("the unwrap menu reflects the WSOL balance", async () => {
    seedWallet({ wsol: 3 * LAMPORTS });
    await press("cmd_unwrap", { userId: USER });
    expect(lastText()).toContain("Unwrap converts WSOL back to native SOL");
    expect(answers()).toContain("🧼 Ready to unwrap WSOL");

    seedWallet({ wsol: 0 });
    await press("cmd_unwrap", { userId: USER });
    expect(lastText()).toContain("You currently have no WSOL to unwrap.");
    expect(answers()).toContain("ℹ️ No WSOL balance found");
  });

  test("unwrapping reports success, empty accounts and failures", async () => {
    stub(wallet, "unwrapSol", async () => ({ signature: "unwrap-sig", amountLamports: LAMPORTS }));
    await press("unwrap_confirm", { userId: USER });
    expect(lastText()).toContain("Unwrap Completed");
    expect(answers().at(-1)).toBe("✅ WSOL unwrapped");

    stub(wallet, "unwrapSol", async () => {
      throw new Error("No WSOL account found");
    });
    await press("unwrap_confirm", { userId: USER });
    expect(lastText()).toContain("Your WSOL account is already empty.");
    expect(answers().at(-1)).toBe("ℹ️ No WSOL to unwrap");

    stub(wallet, "unwrapSol", async () => {
      throw new Error("rpc down");
    });
    await press("unwrap_confirm", { userId: USER });
    expect(answers().at(-1)).toBe("❌ Unwrap failed");
  });
});

describe("send confirmation edge cases", () => {
  let txCounter = 0;
  const pending = (fields: Record<string, unknown>) => {
    const txId = `edge-${++txCounter}`;
    storePendingTransaction(txId, {
      type: "send",
      userId: String(USER),
      address: recipient,
      ...fields,
    });
    return `confirm_send_${txId}`;
  };

  test("summarises a stored amount when no display label was saved", async () => {
    await press(pending({ token: "SOL", amount: "0.5" }), { userId: USER });
    expect(texts()).toContain(
      "⏳ <b>Sending…</b>\n\nSending 0.5 SOL...\n\n<i>This usually takes a few seconds.</i>",
    );
    expect(transfers.find((entry) => entry.kind === "sol")?.args[2]).toBe(LAMPORTS / 2);

    await press(pending({ token: TOKEN_MINT, amount: "max" }), { userId: USER });
    expect(texts().some((text) => text.includes(`Sending MAX ${TOKEN_MINT}...`))).toBe(true);
    expect(transfers.find((entry) => entry.kind === "token")?.args[2]).toBe(2_500_000);
  });

  test.each([
    ["no recipient", { token: "SOL", amount: "0.1", address: "" }],
    ["no token", { token: "", amount: "1" }],
    ["a token missing from the wallet", { token: "NOPE", amount: "1" }],
  ])("fails a send with %s without moving funds", async (_label, fields) => {
    await press(pending(fields), { userId: USER });

    expect(answers().at(-1)).toBe("❌ Send failed");
    expect(transfers.filter((entry) => entry.kind !== "confirm")).toEqual([]);
  });

  test("fails a MAX token send when the balance is empty", async () => {
    seedWallet({ tokenBalance: 0 });

    await press(pending({ token: TOKEN_MINT, amount: "max" }), { userId: USER });

    expect(answers().at(-1)).toBe("❌ Send failed");
    expect(lastText()).toContain("Something went wrong");
    expect(transfers).toEqual([]);
  });

  test("fails a send for a wallet token without a mint", async () => {
    walletTokens = [{ mint: "", ticker: "GHOST", balance: 10, decimals: 0, rawBalance: "10" }];
    botModule.__test_clearWalletCache(BigInt(USER));
    botModule.__test_setWalletCache(BigInt(USER), {
      solBalance: LAMPORTS,
      tokenBalances: walletTokens,
    });

    await press(pending({ token: "GHOST", amount: "1" }), { userId: USER });

    expect(answers().at(-1)).toBe("❌ Send failed");
    expect(transfers).toEqual([]);
  });

  test("the address prompt still works when the wallet address cannot be derived", async () => {
    stub(wallet, "getKeyPair", async () => {
      throw new Error("derivation failed");
    });

    await press("send_amount_SOL_25%", { userId: USER });

    expect(lastText()).toContain("Enter destination address");
  });
});

describe("wallet transaction callbacks without a Telegram identity", () => {
  test.each(["cmd_unwrap", "wrap_amount_50%", "unwrap_confirm", `confirm_wrap_${LAMPORTS}`])(
    "%s asks the user to open a direct chat",
    async (data) => {
      const wraps: unknown[] = [];
      stub(wallet, "wrapSol", async (...args: unknown[]) => {
        wraps.push(args);
        return "sig";
      });
      stub(wallet, "unwrapSol", async (...args: unknown[]) => {
        wraps.push(args);
        return { signature: "sig", amountLamports: 1 };
      });

      await press(data, { userId: 0, chatId: 5, chatType: "private" });

      expect(answers()).toContain("❌ Unable to resolve Telegram identity");
      expect(wraps).toEqual([]);
    },
  );
});

describe("custom wrap input edge cases", () => {
  test("a zero amount is rejected", async () => {
    await press("wrap_custom", { userId: USER });
    await replyToPrompt("0");
    expect(lastText()).toContain("Error processing input");
  });

  test("the confirmation is still shown when balances cannot be loaded", async () => {
    await press("wrap_custom", { userId: USER });
    botModule.__test_clearWalletCache(BigInt(USER));
    stub(wallet, "getAllWalletTokenBalances", async () => {
      throw new Error("rpc down");
    });
    stub(wallet, "getBalance", async () => {
      throw new Error("rpc down");
    });

    await replyToPrompt("0.25");

    expect(lastText()).toContain("Wrap Confirmation");
  });
});

describe("input handlers guard their sessions", () => {
  const ctxFor = (userId?: number) =>
    ({
      from: userId === undefined ? undefined : { id: userId },
      chat: { id: USER, type: "private" },
      message: { message_id: 5 },
      api: bot.api,
      reply: (text: string, options?: unknown) => bot.api.sendMessage(USER, text, options),
    }) as any;

  test("reject input from someone other than the prompt's owner", async () => {
    await expect(
      botModule.__test_handleAddressInput(
        ctxFor(OTHER_USER),
        { initiatorId: String(USER) },
        recipient,
      ),
    ).rejects.toThrow("Input prompt locked to a different user");
  });

  test("reject input when the sender is unknown", async () => {
    await expect(
      botModule.__test_handleWrapAmountInput(ctxFor(), { initiatorId: String(USER) }, "1"),
    ).rejects.toThrow("Unable to resolve user for prompt session");
  });

  test("reject a custom amount for a token that left the wallet", async () => {
    await expect(
      botModule.__test_handleCustomAmountInput(
        ctxFor(USER),
        { initiatorId: String(USER), token: "GONE" },
        "1",
      ),
    ).rejects.toThrow("Token GONE not found in wallet");
  });

  test("the confirmation targets the current chat when the session has no chat id", async () => {
    const sent: Array<{ chatId: unknown; text: string }> = [];
    const ctx = {
      ...ctxFor(USER),
      reply: async (text: string) => {
        sent.push({ chatId: "reply", text });
        return { message_id: 9, chat: { id: USER } };
      },
      api: {
        sendMessage: async (chatId: number, text: string) => {
          sent.push({ chatId, text });
          return { message_id: 9, chat: { id: chatId } };
        },
        editMessageText: async () => {
          throw new Error("nothing to edit");
        },
      },
    } as any;

    await botModule.__test_handleAddressInput(
      ctx,
      { initiatorId: String(USER), token: "SOL", amount: "0.1" },
      recipient,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Send Confirmation");
    expect(sent[0]!.text).toContain("0.1 SOL");
    expect([USER, "reply"]).toContain(sent[0]!.chatId as any);
  });
});

describe("Telegram failures while showing wallet transaction menus", () => {
  test("unwrap reports failure when the progress message cannot be shown", async () => {
    const unwraps: unknown[] = [];
    stub(wallet, "unwrapSol", async (...args: unknown[]) => {
      unwraps.push(args);
      return { signature: "sig", amountLamports: LAMPORTS };
    });
    failApiMethod("editMessageText", "Bad Request: chat not found");
    failApiMethod("sendMessage", "Forbidden: bot was blocked by the user", 403);

    await press("unwrap_confirm", { userId: USER });

    expect(unwraps).toEqual([]);
    // The fallback error menu fails too, so the global handler answers the callback.
    expect(answers().at(-1)).toStartWith("❌");
  });

  test("send confirmation reports an error when the progress message cannot be shown", async () => {
    await press("send_amount_SOL_25%", { userId: USER });
    await replyToPrompt(recipient);
    const confirm = confirmButton("confirm_send_");
    failApiMethod("editMessageText", "Bad Request: chat not found");
    failApiMethod("sendMessage", "Forbidden: bot was blocked by the user", 403);

    await press(confirm, { userId: USER });

    expect(transfers).toEqual([]);
    expect(answers().at(-1)).toBe("❌ Error processing transaction");
  });

  test("token selection reports an error when the menu cannot be shown", async () => {
    failApiMethod("editMessageText", "Bad Request: chat not found");
    failApiMethod("sendMessage", "Forbidden: bot was blocked by the user", 403);

    await press(`send_select_${TOKEN_MINT}`, { userId: USER });

    expect(answers().at(-1)).toBe("❌ Error processing selection");
  });
});
