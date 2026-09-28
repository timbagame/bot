import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  answers,
  calls,
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

describe("/start and /balance", () => {
  const walletCard = () =>
    calls.filter((call) => /^send(Photo|Video|Animation|Message)$/.test(call.method)).at(-1);
  const cardText = () => String(walletCard()?.payload.caption ?? walletCard()?.payload.text ?? "");

  test("/start opens the wallet in a private chat", async () => {
    await sendText("/start", { userId: USER });

    expect(walletCard()?.payload.chat_id).toBe(USER);
    expect(cardText()).toContain("SOL: <code>2</code> SOL");
  });

  test("/balance in a group sends the wallet privately", async () => {
    await sendText("/balance", { userId: USER, chatId: -4_401 });

    expect(walletCard()?.payload.chat_id).toBe(String(USER));
    expect(cardText()).toContain("SOL: <code>2</code> SOL");
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
