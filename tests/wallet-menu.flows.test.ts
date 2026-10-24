import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  answers,
  calls,
  failApiMethod,
  overrideApiMethod,
  resetCalls,
  restoreStubs,
  press,
  sendText,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import { TransactionHistory } from "../src/utils/transaction-history";
import { WSOL_MINT } from "../src/utils/constants";

useBotHarness();

const LAMPORTS = 1_000_000_000;
let USER = 91_000;
let solBalance: number;
let pageRequests: number[];

const walletCaption = () => {
  const media = calls.filter((call) => call.method === "editMessageMedia").at(-1);
  return (media?.payload.media.caption ?? "") as string;
};
const walletButtons = () =>
  (
    calls.filter((call) => call.method === "editMessageMedia").at(-1)?.payload.reply_markup
      .inline_keyboard ?? []
  )
    .flat()
    .map((button: any) => button.callback_data as string);

beforeEach(() => {
  USER += 1;
  resetCalls();
  solBalance = 2 * LAMPORTS;
  pageRequests = [];
  stub(wallet, "getBalance", async () => solBalance);
  stub(wallet, "getWalletTokenBalancePage", async (_id: bigint, _known: unknown, page: number) => {
    pageRequests.push(page);
    return {
      tokenBalances:
        page === 1
          ? [
              {
                mint: "BonkMint",
                ticker: "BONK",
                balance: 5,
                decimals: 0,
                rawBalance: "5",
                formattedBalance: "5",
                decimalBalance: 5,
              },
            ]
          : [],
      page,
      pageCount: 2,
      heldMints: ["BonkMint"],
      complete: true,
    };
  });
});

afterEach(() => {
  restoreStubs();
});

describe("/start, /balance and /wallet", () => {
  const walletCard = () =>
    calls.filter((call) => /^send(Photo|Video|Animation|Message)$/.test(call.method)).at(-1);
  const cardText = () => String(walletCard()?.payload.caption ?? walletCard()?.payload.text ?? "");

  test("/start opens the wallet in a private chat", async () => {
    await sendText("/start", { userId: USER });

    expect(walletCard()?.payload.chat_id).toBe(USER);
    expect(cardText()).toContain("SOL: <code>2</code> SOL");
  });

  test("/wallet and /balance send the same wallet as /start", async () => {
    const cards = [];
    for (const text of ["/start", "/wallet", "/Wallet@test_bot", "/balance"]) {
      calls.length = 0;
      await sendText(text, { userId: USER });
      // Each card replies to its own command; everything else must match.
      const { reply_to_message_id: _, ...card } = walletCard()!.payload;
      cards.push(card);
    }

    expect(cards[0]!.chat_id).toBe(USER);
    expect(String(cards[0]!.caption ?? cards[0]!.text)).toContain("SOL: <code>2</code> SOL");
    expect(cards.slice(1)).toEqual([cards[0], cards[0], cards[0]]);
  });

  const GROUP = -4_401;
  const SUMMARY_FOOTER = "<i>The full wallet menu is in our private chat.</i>";
  const DM_NOTICE = [
    "❌ <b>I can’t DM you yet</b>",
    "",
    "Start a private chat with the bot so I can share your balances.",
    'Tap <a href="https://t.me/test_bot">@test_bot</a> and press <b>Start</b>, then run /balance again.',
  ].join("\n");
  const groupMessages = () =>
    calls.filter((call) => call.method === "sendMessage" && call.payload.chat_id === GROUP);
  const dmCard = () => calls.find((call) => call.payload.chat_id === String(USER));
  const failInGroup = (description: string, when: (payload: any) => boolean = () => true) => {
    overrideApiMethod("sendMessage", (payload) =>
      payload.chat_id === GROUP && when(payload)
        ? { ok: false, error_code: 400, description }
        : { message_id: 700_001, date: 0, chat: { id: payload.chat_id, type: "supergroup" } },
    );
  };

  test("/balance in a group sends the wallet privately and a copy only the sender sees", async () => {
    await sendText("/balance", { userId: USER, chatId: GROUP, messageId: 4_402 });

    const caption = String(dmCard()?.payload.caption);
    expect(caption).toContain("SOL: <code>2</code> SOL");
    expect(groupMessages().map((call) => call.payload)).toEqual([
      {
        chat_id: GROUP,
        text: `${caption}\n\n${SUMMARY_FOOTER}`,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: 4_402, allow_sending_without_reply: true },
        ephemeral_message_parameters: { receiver_user_id: USER },
      },
    ]);
  });

  test("every /balance in a group shows its own copy, as a reply to that command", async () => {
    await sendText("/balance", { userId: USER, chatId: GROUP, messageId: 4_403 });
    await sendText("/balance", { userId: USER, chatId: GROUP, messageId: 4_404 });

    expect(groupMessages().map((call) => call.payload.reply_parameters.message_id)).toEqual([
      4_403, 4_404,
    ]);
    expect(groupMessages()[1]!.payload.text).toBe(groupMessages()[0]!.payload.text);
  });

  test("/balance in a group posts nothing there when the bot is not an admin", async () => {
    failInGroup("Bad Request: BOT_NOT_ADMIN");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sendText("/balance", { userId: USER, chatId: GROUP });

      expect(String(dmCard()?.payload.caption)).toContain("SOL: <code>2</code> SOL");
      expect(groupMessages()).toHaveLength(1);
      expect(groupMessages()[0]!.payload.ephemeral_message_parameters).toEqual({
        receiver_user_id: USER,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("/balance in a group logs any other refusal of the copy and keeps the DM", async () => {
    failInGroup("Bad Request: chat not found");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sendText("/balance", { userId: USER, chatId: GROUP });

      expect(String(dmCard()?.payload.caption)).toContain("SOL: <code>2</code> SOL");
      expect(groupMessages()).toHaveLength(1);
      expect(warn.mock.calls).toEqual([
        ["Failed to show the wallet summary in the group:", "Bad Request: chat not found"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("/balance in a group tells only the sender, in reply to it, to start a DM when the bot cannot DM them", async () => {
    failApiMethod("sendVideo", "Forbidden: bot can't initiate conversation with a user", 403);

    await sendText("/balance", { userId: USER, chatId: GROUP, messageId: 4_405 });

    expect(groupMessages().map((call) => call.payload)).toEqual([
      {
        chat_id: GROUP,
        text: DM_NOTICE,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: 4_405, allow_sending_without_reply: true },
        ephemeral_message_parameters: { receiver_user_id: USER },
      },
    ]);
  });

  test("/balance in a group posts the DM notice publicly when the bot is not an admin", async () => {
    failApiMethod("sendVideo", "Forbidden: bot can't initiate conversation with a user", 403);
    failInGroup(
      "Bad Request: BOT_NOT_ADMIN",
      (payload) => "ephemeral_message_parameters" in payload,
    );

    await sendText("/balance", { userId: USER, chatId: GROUP, messageId: 4_406 });

    const quote = { message_id: 4_406, allow_sending_without_reply: true };
    expect(groupMessages().map((call) => call.payload)).toEqual([
      {
        chat_id: GROUP,
        text: DM_NOTICE,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_parameters: quote,
        ephemeral_message_parameters: { receiver_user_id: USER },
      },
      {
        chat_id: GROUP,
        text: DM_NOTICE,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_parameters: quote,
      },
    ]);
  });
});

describe("wallet menu buttons", () => {
  test("the wallet button shows the balance with page navigation", async () => {
    await press("main_wallet", { userId: USER });

    expect(walletCaption()).toContain("SOL: <code>2</code> SOL");
    expect(walletButtons()).toContain("wallet_refresh");
    expect(walletButtons()).toContain("wallet_page_1");
    expect(pageRequests).toEqual([0]);
  });

  test("page buttons open the requested token page", async () => {
    await press("wallet_page_1", { userId: USER });

    expect(walletCaption()).toContain("BONK: <code>5</code>");
    expect(walletButtons()).toContain("wallet_page_0");
    expect(pageRequests).toEqual([1]);
  });

  test("refresh drops the cached balance and shows the new one", async () => {
    await press("main_wallet", { userId: USER });
    solBalance = 3 * LAMPORTS;

    await press("wallet_refresh", { userId: USER });

    expect(walletCaption()).toContain("SOL: <code>3</code> SOL");
  });

  test("settings opens the settings menu", async () => {
    await press("wallet_settings", { userId: USER });

    const edit = calls.filter((call) => call.method === "editMessageText").at(-1)!;
    expect(edit.payload.text).toBe("⚙️ Settings\n\nChoose an option:");
    expect(answers()).toContain("⚙️ Settings");
  });

  test.each(["wallet_positions", "wallet_pos_r_0", "wallet_pos_1"])(
    "%s opens the positions view",
    async (data) => {
      await press(data, { userId: USER });

      const edit = calls.filter((call) => call.method === "editMessageText").at(-1)!;
      expect(edit.payload.text).toStartWith("📊 Positions");
    },
  );
});

test("positions combine wallet holdings with recorded swaps", async () => {
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  stub(wallet, "getAllWalletTokenBalances", async () => [
    {
      mint: BONK,
      ticker: "BONK",
      balance: 500_000,
      decimals: 5,
      rawBalance: "500000",
      decimalBalance: 5,
    },
  ]);
  const history = TransactionHistory.getInstance();
  const walletAddresses: string[] = [];
  stub(history, "getSwapsByWallet", ((address: string) => {
    walletAddresses.push(address);
    return [
      {
        signature: "buy-1",
        wallet: address,
        input_mint: WSOL_MINT,
        output_mint: BONK,
        input_ticker: "SOL",
        output_ticker: "BONK",
        amount_in: String(LAMPORTS),
        amount_out: "500000",
        referral_applied: false,
        timestamp: 1,
      },
    ];
  }) as any);

  await press("wallet_positions", { userId: USER });

  const edit = calls.filter((call) => call.method === "editMessageText").at(-1)!;
  expect(edit.payload.text).toStartWith("📊 BONK");
  expect(edit.payload.text).toContain("Balance: <code>5</code>");
  expect(edit.payload.text).toContain("Spent: 1 SOL, 1 buy");
  expect(walletAddresses).toHaveLength(1);
});
