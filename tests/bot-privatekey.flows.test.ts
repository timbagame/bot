import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import {
  answers,
  buttons,
  callsTo,
  failApiMethod,
  lastMessage,
  lastText,
  press,
  resetCalls,
  restoreStubs,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";

useBotHarness();

let USER = 97_000;
let keypair: Keypair;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  USER += 1;
  resetCalls();
  keypair = await Keypair.generate();
  stub(wallet, "getKeyPair", async () => keypair);
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  restoreStubs();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

const at = (data: string, userId = USER) => press(data, { userId });

describe("private key export", () => {
  test("asks for confirmation before revealing the key", async () => {
    await at("cmd_privatekey");

    expect(lastText()).toContain("⚠️ <b>Reveal private key?</b>");
    expect(buttons(lastMessage())).toEqual([
      { text: "Reveal private key", data: "confirm_privatekey" },
      { text: "Cancel", data: "settings" },
    ]);
    expect(answers().at(-1)).toBe("Confirmation required");
  });

  test("reveals the key once after confirmation and deletes the message after a minute", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      timers.push({ fn, ms });
      return { unref: () => undefined } as any;
    }) as any);

    try {
      await at("cmd_privatekey");
      await at("confirm_privatekey");
    } finally {
      timeoutSpy.mockRestore();
    }

    const secret = Buffer.from(keypair.secretKey).toString("base64");
    const shown = callsTo("sendMessage").at(-1)!;
    expect(shown.payload.text).toContain(`<code>${keypair.publicKey.toBase58()}</code>`);
    expect(shown.payload.text).toContain(`<span class="tg-spoiler"><code>${secret}</code></span>`);
    expect(answers().at(-1)).toBe("🔐 Private key shown");

    const deletion = timers.find((timer) => timer.ms === 60_000)!;
    deletion.fn();
    await Bun.sleep(0);
    expect(callsTo("deleteMessage").at(-1)?.payload).toMatchObject({
      chat_id: USER,
      message_id: shown.result.message_id,
    });

    // The confirmation is single-use.
    await at("confirm_privatekey");
    expect(answers().at(-1)).toBe("❌ Confirmation expired. Try again.");
  });

  test("a failed auto-delete is ignored", async () => {
    let deletion: (() => void) | undefined;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      deletion = fn;
      return {} as any;
    }) as any);
    try {
      await at("cmd_privatekey");
      await at("confirm_privatekey");
    } finally {
      timeoutSpy.mockRestore();
    }
    failApiMethod("deleteMessage", "Bad Request: message to delete not found");

    deletion!();
    await Bun.sleep(0);

    expect(callsTo("deleteMessage")).toHaveLength(1);
  });

  test("confirming without a pending request is refused", async () => {
    await at("confirm_privatekey");
    expect(answers().at(-1)).toBe("❌ Confirmation expired. Try again.");
  });

  test("a confirmation older than a minute expires", async () => {
    await at("cmd_privatekey");
    const realNow = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(realNow + 61_000);
    try {
      await at("confirm_privatekey");
    } finally {
      nowSpy.mockRestore();
    }

    expect(answers().at(-1)).toBe("❌ Confirmation expired. Try again.");
    expect(callsTo("sendMessage")).toHaveLength(0);
  });

  test("at most three exports are allowed per hour", async () => {
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (() => ({}) as any) as any,
    );
    try {
      for (let i = 0; i < 3; i++) {
        await at("cmd_privatekey");
        await at("confirm_privatekey");
        expect(answers().at(-1)).toBe("🔐 Private key shown");
      }
      await at("cmd_privatekey");
      await at("confirm_privatekey");
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(answers().at(-1)).toBe("❌ Too many exports. Try again later.");
    expect(callsTo("sendMessage")).toHaveLength(3);
  });

  test("both steps are refused outside private chats", async () => {
    await press("cmd_privatekey", { userId: USER, chatId: -77 });
    expect(answers().at(-1)).toBe("❌ Private key only available in private chat");

    await press("confirm_privatekey", { userId: USER, chatId: -77 });
    expect(answers().at(-1)).toBe("❌ Private key only available in private chat");
    expect(callsTo("sendMessage")).toHaveLength(0);
  });

  test("a wallet failure is acknowledged with an error", async () => {
    stub(wallet, "getKeyPair", async () => {
      throw new Error("keystore unavailable");
    });

    await at("cmd_privatekey");
    await at("confirm_privatekey");

    expect(answers().at(-1)).toBe("❌ Error showing private key");
    expect(callsTo("sendMessage")).toHaveLength(0);
  });
});
