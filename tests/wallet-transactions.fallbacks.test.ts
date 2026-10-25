import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "#solana";
import {
  answers,
  botModule,
  callsTo,
  overrideApiMethod,
  press,
  resetCalls,
  restoreStubs,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";

useBotHarness();

let USER = 91_000;

beforeEach(() => {
  USER += 1;
  resetCalls();
});

afterEach(() => {
  restoreStubs();
});

describe("send confirmation without a chat on the context", () => {
  test("replies in place instead of targeting a chat id", async () => {
    const recipient = (await Keypair.generate()).publicKey.toBase58();
    const replies: Array<{ text: string; options: any }> = [];
    const sent: unknown[] = [];
    const ctx = {
      from: { id: USER },
      message: { message_id: 5 },
      reply: async (text: string, options: any) => {
        replies.push({ text, options });
        return { message_id: 9 };
      },
      api: {
        sendMessage: async (...args: unknown[]) => {
          sent.push(args);
          return { message_id: 10, chat: { id: USER } };
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

    expect(sent).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("Send Confirmation");
    expect(replies[0]!.text).toContain(recipient);
    expect(replies[0]!.options.reply_to_message_id).toBe(5);
  });
});

describe("unwrap confirmation outer error handling", () => {
  test("shows the friendly error and answers when the progress menu cannot be shown", async () => {
    const unwraps: unknown[] = [];
    stub(wallet, "unwrapSol", async (...args: unknown[]) => {
      unwraps.push(args);
      return { signature: "sig", amountLamports: 1_000_000_000 };
    });

    // The progress menu fails to render (edit, then the send fallback), which makes
    // executeUnwrapFlow throw before the conversion starts. The outer catch then renders fine.
    let failuresLeft = 2;
    const failWhileBudgetLasts = () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { ok: false, error_code: 400, description: "Bad Request: chat not found" };
      }
      return { message_id: 4242, date: 1, chat: { id: USER, type: "private" }, text: "ok" };
    };
    overrideApiMethod("editMessageText", failWhileBudgetLasts);
    overrideApiMethod("sendMessage", failWhileBudgetLasts);

    await press("unwrap_confirm", { userId: USER });

    expect(unwraps).toEqual([]);
    expect(answers().at(-1)).toBe("❌ Unwrap failed");
    const delivered = [...callsTo("editMessageText"), ...callsTo("sendMessage")].filter(
      (call) => call.result?.message_id === 4242,
    );
    expect(delivered.length).toBeGreaterThan(0);
  });
});
