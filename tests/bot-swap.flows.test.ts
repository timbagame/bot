import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  answers,
  botModule,
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
import * as priceService from "../src/utils/price-service";
import * as pricesModule from "../src/utils/prices";
import * as holderModule from "../src/services/buy-alerts/holder";
import { WSOL_MINT } from "../src/utils/constants";
import { clearAllInputSessions, storePendingTransaction } from "../src/utils/user-state";

useBotHarness();

const LAMPORTS = 1_000_000_000;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
let USER = 83_000;

let saved: { tokenManager: any; swaps: any; rent: number };
let prepareSwap: ReturnType<typeof mock>;
let execute: ReturnType<typeof mock>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let priceSpy: ReturnType<typeof spyOn>;

const quote = (overrides: Record<string, unknown> = {}) => ({
  provider: "jupiter",
  inputMint: WSOL_MINT,
  outputMint: USDC,
  inputAmountRaw: "500000000",
  outputAmount: "75000000",
  inputDecimals: 9,
  outputDecimals: 6,
  inputTicker: "SOL",
  priceImpactPct: 0.1,
  slippageBps: 50,
  ...overrides,
});

beforeEach(() => {
  USER += 1;
  resetCalls();
  clearAllInputSessions();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  saved = {
    tokenManager: botModule.__test_getTokenManager(),
    swaps: botModule.__test_getSwapManagers(),
    rent: botModule.__test_getSolWrapRentReserveLamports(),
  };
  botModule.__test_setSolWrapRentReserveLamports(2_039_280);
  botModule.__test_resetPrepareTokenTradeQuote();
  botModule.__test_swapQuoteRetryStore.clear();
  prepareSwap = mock(async (): Promise<any> => quote());
  execute = mock(async (): Promise<any> => "swap-signature");
  botModule.__test_setSwapManagers({
    swapManager: {} as any,
    swapService: { prepareSwap, execute } as any,
  });
  botModule.__test_setTokenManager({
    resolveMintForTicker: async (ticker: string) =>
      ({ SOL: WSOL_MINT, USDC, BONK })[ticker.toUpperCase()] ?? null,
    getAllKnownTokensWithMetadata: () => [],
    resolveSwapToken: async (input: string) =>
      input.toUpperCase() === "BONK"
        ? { token_mint: BONK, token_ticker: "bonk", decimals: 5, newlyDiscovered: true }
        : null,
  } as any);
  priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue({ price: 150 } as any);
  stub(wallet, "getBalance", async () => 5 * LAMPORTS);
  stub(wallet, "getAllWalletTokenBalances", async () => [
    { mint: USDC, ticker: "USDC", balance: 20_000_000, decimals: 6, rawBalance: "20000000" },
  ]);
  stub(wallet, "getTokenMetadata", async (mint: string) => ({
    decimals: mint === USDC ? 6 : 5,
  }));
});

afterEach(() => {
  botModule.__test_setTokenManager(saved.tokenManager);
  botModule.__test_setSwapManagers(saved.swaps);
  botModule.__test_setSolWrapRentReserveLamports(saved.rent);
  priceSpy.mockRestore();
  restoreStubs();
  clearAllInputSessions();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const at = (data: string) => press(data, { userId: USER });
const callbackStarting = (prefix: string) =>
  buttons(
    messageCalls()
      .filter((call) => buttons(call).some((button) => button.data?.startsWith(prefix)))
      .at(-1),
  ).find((button) => button.data.startsWith(prefix))!.data;
const replyToPrompt = async (text: string) => {
  const prompt = messageCalls()
    .filter((call) => /Reply to this message|Send the token|symbol/i.test(messageText(call)))
    .at(-1)!;
  await sendText(text, { userId: USER, replyTo: prompt.result?.message_id ?? 77 });
};

describe("choosing a swap pair", () => {
  test("offers SOL and popular tokens when swapping from a token", async () => {
    await at("swap_from_USDC");

    expect(lastText()).toContain("💱 <b>Swap USDC</b>");
    expect(buttons(lastMessage()).map((button) => button.data)).toEqual([
      "swap_to_USDC_SOL",
      "swap_to_USDC_WSOL",
      "swap_to_USDC_TIMBA",
      "swap_to_USDC_OTHER",
      "cmd_swap",
    ]);
  });

  test("a wallet failure while opening the pair is acknowledged", async () => {
    stub(wallet, "getKeyPair", async () => {
      throw new Error("keystore unavailable");
    });

    await at("swap_from_USDC");

    expect(errorSpy).toHaveBeenCalledWith("Error in swap_from selection:", expect.any(Error));
    expect(answers().at(-1)).toBe("❌ Error processing swap selection");
  });

  test("does not offer SOL as a target when swapping from SOL", async () => {
    await at("swap_from_SOL");

    const data = buttons(lastMessage()).map((button) => button.data);
    expect(data).not.toContain("swap_to_SOL_SOL");
    expect(data).toContain("swap_to_SOL_USDC");
  });

  test("shows the amount choices with the source balance", async () => {
    await at("swap_to_SOL_USDC");

    expect(lastText()).toContain("<b>From:</b> SOL (5");
    expect(lastText()).toContain("<b>To:</b> USDC");
    expect(answers().at(-1)).toBe("SOL → USDC");
  });

  test("an incomplete pair passes through", async () => {
    await at("swap_to_SOL");
    expect(answers()).not.toContain("❌ Invalid swap pair");
  });
});

describe("quoting and confirming a swap", () => {
  test("quotes a percentage, then executes it on confirmation", async () => {
    await at("swap_amount_SOL_USDC_50%");

    expect(texts().some((text) => text.includes("⏳ <b>Getting a quote…</b>"))).toBe(true);
    expect(lastText()).toContain("Confirm this swap?");
    const request = (prepareSwap.mock.calls[0] as any[])[0];
    expect(request).toMatchObject({ inputMint: WSOL_MINT, outputMint: USDC, outputDecimals: 6 });

    await at(callbackStarting("confirm_swap_"));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(lastText()).toContain("✅ <b>Swap Completed</b>");
    expect(lastText()).toContain("Received ~75 USDC");
    expect(answers().at(-1)).toBe("✅ Swap submitted");
  });

  test("a failed execution explains the error", async () => {
    execute.mockImplementation(async () => {
      throw new Error("Jupiter error: no route found");
    });
    await at("swap_amount_SOL_USDC_25%");

    await at(callbackStarting("confirm_swap_"));

    expect(lastText()).toContain("No swap route");
  });

  test("a failed quote offers to try again", async () => {
    prepareSwap.mockImplementation(async () => null);

    await at("swap_amount_USDC_SOL_50%");

    expect(buttons(lastMessage())[0]).toMatchObject({
      text: "← Try Again",
      data: "swap_to_USDC_SOL",
    });
  });

  test("a slow provider offers a one-tap retry for the same user", async () => {
    prepareSwap.mockImplementationOnce(async () => {
      throw new Error("Failed to request Jupiter order: The operation timed out.", {
        cause: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      });
    });
    await at("swap_amount_SOL_USDC_25%");
    const retry = buttons(lastMessage())[0]!.data;

    await press(retry, { userId: USER + 10_000 });
    expect(answers().at(-1)).toBe("❌ This quote belongs to someone else");

    await at(retry);
    expect(lastText()).toContain("Confirm this swap?");

    botModule.__test_swapQuoteRetryStore.clear();
    await at(retry);
    expect(answers().at(-1)).toBe("⌛ This quote expired. Pick the amount again.");
  });

  test("confirmations expire and belong to their creator", async () => {
    await at("confirm_swap_missing");
    expect(answers().at(-1)).toBe("❌ Transaction expired or not found");

    await at("swap_amount_SOL_USDC_25%");
    await press(callbackStarting("confirm_swap_"), { userId: USER + 20_000, chatId: USER });
    expect(answers().at(-1)).toBe("❌ Unauthorized transaction");
  });

  test("a stored swap without a quote fails safely", async () => {
    storePendingTransaction("noquote", {
      type: "swap",
      fromToken: "USDC",
      toToken: "SOL",
      amount: "1",
      rawAmount: "1000000",
      userId: String(USER),
    });

    await at("confirm_swap_noquote");

    expect(execute).not.toHaveBeenCalled();
    expect(answers().at(-1)).toBe("✅ Swap submitted");
  });

  test("SOL to WSOL swaps wrap natively", async () => {
    const wraps: unknown[][] = [];
    stub(wallet, "wrapSol", async (...args: unknown[]) => {
      wraps.push(args);
      return "wrap-sig";
    });
    stub(wallet, "confirmTransaction", async () => {});
    storePendingTransaction("wrap-swap", {
      type: "swap",
      fromToken: "SOL",
      toToken: "WSOL",
      amount: "0.5",
      rawAmount: String(LAMPORTS / 2),
      userId: String(USER),
    });

    await at("confirm_swap_wrap-swap");

    expect(wraps).toEqual([[BigInt(USER), LAMPORTS / 2]]);
    expect(answers().at(-1)).toBe("✅ Wrapped SOL to WSOL");
  });
});

describe("custom swap inputs", () => {
  test("another token can be looked up by symbol", async () => {
    await at("swap_to_SOL_OTHER");
    expect(answers().at(-1)).toBe("Send token mint or symbol");

    await replyToPrompt("bonk");

    expect(lastText()).toContain("<b>To:</b> BONK");
  });

  test("an unknown token keeps the prompt open", async () => {
    await at("swap_to_SOL_OTHER");

    await replyToPrompt("nothing");

    expect(lastText()).toContain("❌ <b>Token Not Found</b>");
  });

  test("a custom amount is quoted", async () => {
    await at("swap_amount_SOL_USDC_CUSTOM");
    expect(answers().at(-1)).toBe("Send amount as message");

    await replyToPrompt("0.5");

    expect(lastText()).toContain("Confirm this swap?");
    expect((prepareSwap.mock.calls[0] as any[])[0].amount).toBe(String(LAMPORTS / 2));
  });
});

describe("swap confirmation side effects", () => {
  let chatId: number;
  let fetchSpy: ReturnType<typeof spyOn>;
  let pricesSpy: ReturnType<typeof spyOn>;
  let holderSpy: ReturnType<typeof spyOn>;
  const originalRpcUrl = process.env["RPC_URL"];
  let signature = 0;

  beforeEach(() => {
    // Buy alerts for the swapped-into token are posted to the user's own chat.
    chatId = USER;
    execute.mockImplementation(async () => `swap-signature-${++signature}`);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    pricesSpy = spyOn(pricesModule, "getPricesUSD").mockResolvedValue({ [WSOL_MINT]: 150 });
    holderSpy = spyOn(holderModule, "detectNewHolder").mockResolvedValue(true);
    const tokenManager = botModule.__test_getTokenManager() as any;
    tokenManager.getChatDefaultToken = () => null;
    tokenManager.getDefaultToken = () => ({ tokenMint: BONK, tokenTicker: "BONK" });
  });

  afterEach(() => {
    botModule.__test_getChatDatabase().upsertChatBuyAlerts(chatId, { enabled: false });
    fetchSpy.mockRestore();
    pricesSpy.mockRestore();
    holderSpy.mockRestore();
    if (originalRpcUrl === undefined) delete process.env["RPC_URL"];
    else process.env["RPC_URL"] = originalRpcUrl;
  });

  const enableAlerts = (media: Record<string, unknown> = {}) =>
    botModule.__test_getChatDatabase().upsertChatBuyAlerts(chatId, {
      enabled: true,
      token_mint: USDC,
      token_ticker: "USDC",
      ...media,
    });

  const confirmSwap = async () => {
    await at("swap_amount_SOL_USDC_50%");
    await at(callbackStarting("confirm_swap_"));
    // The alert is published in the background.
    await Bun.sleep(5);
  };

  test("a completed swap into an alerted token posts a buy alert with SOL value", async () => {
    enableAlerts();

    await confirmSwap();

    const alert = messageCalls().find(
      (call) => call.method === "sendMessage" && call.payload.chat_id === chatId,
    );
    expect(messageText(alert)).toContain("USDC");
    expect(pricesSpy).toHaveBeenCalledWith([WSOL_MINT]);
    expect(holderSpy).toHaveBeenCalledTimes(1);
  });

  test("buy alerts use the chat's photo, GIF or video", async () => {
    for (const [mediaType, method] of [
      ["photo", "sendPhoto"],
      ["animation", "sendAnimation"],
      ["video", "sendVideo"],
    ] as const) {
      resetCalls();
      chatId = USER * 10 + method.length;
      enableAlerts({ media_file_id: `${mediaType}-file`, media_type: mediaType });
      // Route the alert to this chat by making it the user's chat.
      await press("swap_amount_SOL_USDC_50%", { userId: USER, chatId });
      await press(callbackStarting("confirm_swap_"), { userId: USER, chatId });
      await Bun.sleep(5);

      const call = messageCalls().find((entry) => entry.method === method);
      expect(call?.payload).toMatchObject({ chat_id: chatId, parse_mode: "HTML" });
      botModule.__test_getChatDatabase().upsertChatBuyAlerts(chatId, { enabled: false });
    }
  });

  test("a failing buy alert publish is logged without affecting the swap", async () => {
    enableAlerts();
    const db = botModule.__test_getChatDatabase();
    stub(db, "getEnabledChatBuyAlerts", () => {
      throw new Error("chat db locked");
    });

    await confirmSwap();

    expect(lastText()).toContain("✅ <b>Swap Completed</b>");
    expect(errorSpy).toHaveBeenCalledWith("Failed to ingest swap buy alert:", expect.any(Error));
  });

  test("mainnet swaps link to the transaction", async () => {
    process.env["RPC_URL"] = "https://api.mainnet-beta.solana.com";

    await confirmSwap();

    expect(lastText()).toContain("🔗 View transaction");
    expect(lastText()).toContain("swap-signature-");
  });

  test("unexpected failures in the confirmation are reported to the user", async () => {
    stub(wallet, "formatSolBalance", () => {
      throw new Error("formatter exploded");
    });
    storePendingTransaction("wrap-boom", {
      type: "swap",
      fromToken: "SOL",
      toToken: "WSOL",
      amount: "0.5",
      rawAmount: String(LAMPORTS / 2),
      userId: String(USER),
    });

    await at("confirm_swap_wrap-boom");

    expect(errorSpy).toHaveBeenCalledWith("Error in swap confirmation:", expect.any(Error));
    expect(answers().at(-1)).toBe("❌ Error processing swap");
  });
});

describe("swap menu", () => {
  test("lists SOL and funded tokens, and each token opens its swap targets", async () => {
    stub(wallet, "getAllWalletTokenBalances", async () => [
      { mint: USDC, ticker: "USDC", balance: 20, decimals: 6, rawBalance: "20000000" },
      { mint: BONK, ticker: "BONK", balance: 3, decimals: 5 },
      {
        mint: "EmptyMint1111111111111111111111111111111111",
        ticker: "EMPTY",
        balance: 0,
        decimals: 6,
      },
      {
        mint: "ZeroRaw11111111111111111111111111111111111",
        ticker: "ZRAW",
        balance: 1,
        decimals: 6,
        rawBalance: "0",
      },
    ]);

    await at("cmd_swap");

    expect(lastText()).toContain("💱 <b>Swap Tokens</b>");
    expect(lastText()).toContain("Select token to swap FROM");
    expect(answers().at(-1)).toBe("💱 Select token to swap from");
    const labels = buttons(lastMessage()).map((button) => button.text);
    expect(labels.join(" ")).toContain("USDC");
    expect(labels.join(" ")).toContain("BONK");
    expect(labels.join(" ")).not.toContain("EMPTY");
    expect(labels.join(" ")).not.toContain("ZRAW");

    const usdc = buttons(lastMessage()).find((button) => button.text.includes("USDC"))!;
    expect(usdc.data).toMatch(/^swap_from_/);
    await at(usdc.data);
    expect(lastText()).toContain("💱 <b>Swap USDC</b>");
  });

  test("an empty wallet has nothing to swap", async () => {
    stub(wallet, "getBalance", async () => 0);
    stub(wallet, "getAllWalletTokenBalances", async () => []);

    await at("cmd_swap");

    expect(buttons(lastMessage()).map((button) => button.text)).toContain(
      "❌ No tokens available to swap",
    );
  });
});
