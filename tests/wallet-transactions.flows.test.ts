import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "#solana";
import {
  botModule,
  answers,
  buttons,
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
import { clearAllInputSessions } from "../src/utils/user-state";

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
