import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as menuResponse from "../src/utils/menu-response";
import * as contextHelpers from "../src/utils/context-helpers";
import { WSOL_MINT } from "../src/utils/token-registry";
const botModule = await import("../src/bot");

const TELEGRAM_ID = 424242n;

const createMockCtx = () => ({
  from: { id: Number(TELEGRAM_ID) },
  chat: { id: 777 },
  callbackQuery: {
    id: "cb-id",
    message: { message_id: 999, chat: { id: 777 } },
  },
  api: {
    editMessageText: async () => {
      /* no-op */
    },
    editMessageCaption: async () => {
      /* no-op */
    },
    editMessageReplyMarkup: async () => {
      /* no-op */
    },
    answerCallbackQuery: async () => {
      /* no-op */
    },
  },
});

describe("SOL-like swap conversions", () => {
  let respondSpy: ReturnType<typeof spyOn>;
  let answerSpy: ReturnType<typeof spyOn>;
  let wrapSpy: ReturnType<typeof spyOn>;
  let unwrapSpy: ReturnType<typeof spyOn>;
  let balanceSpy: ReturnType<typeof spyOn>;
  let confirmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
    botModule.__test_clearTransactionCache();
    botModule.__test_clearWalletCache(TELEGRAM_ID);

    respondSpy = spyOn(menuResponse, "respondWithMenu").mockResolvedValue({
      chatId: null,
      messageId: null,
      respondedWithReply: false,
    });
    answerSpy = spyOn(contextHelpers, "safeAnswerCallbackQuery").mockResolvedValue();
    balanceSpy = spyOn(botModule.wallet, "getBalance").mockResolvedValue(
      10_000_000_000
    );
    wrapSpy = spyOn(botModule.wallet, "wrapSol").mockResolvedValue(
      "wrap-signature"
    );
    unwrapSpy = spyOn(botModule.wallet, "unwrapSol").mockResolvedValue({
      signature: "unwrap-signature",
      amountLamports: 0,
    });
    confirmSpy = spyOn(botModule.wallet, "confirmTransaction").mockResolvedValue();
  });

  afterEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
    botModule.__test_clearTransactionCache();
    botModule.__test_clearWalletCache(TELEGRAM_ID);

    respondSpy.mockRestore();
    answerSpy.mockRestore();
    balanceSpy.mockRestore();
    wrapSpy.mockRestore();
    unwrapSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  test("wraps SOL when swap pair normalizes to WSOL", async () => {
    const ctx = createMockCtx() as any;

    const handled = await botModule.__test_executeSolLikeSwapConversion({
      ctx,
      telegramId: TELEGRAM_ID,
      amountLamports: 1_000_000_000,
      direction: "wrap",
    });

    expect(handled).toBe(true);
    expect(wrapSpy).toHaveBeenCalledTimes(1);
    expect(wrapSpy).toHaveBeenCalledWith(TELEGRAM_ID, 1_000_000_000);
    expect(unwrapSpy).not.toHaveBeenCalled();
    expect(respondSpy).toHaveBeenCalled();
    expect(answerSpy).toHaveBeenCalled();
  });

  test("unwraps WSOL even when SOL balance is sufficient", async () => {
    const ctx = createMockCtx() as any;

    const handled = await botModule.__test_executeSolLikeSwapConversion({
      ctx,
      telegramId: TELEGRAM_ID,
      amountLamports: 2_500_000_000,
      direction: "unwrap",
    });

    expect(handled).toBe(true);
    expect(unwrapSpy).toHaveBeenCalledTimes(1);
    expect(unwrapSpy).toHaveBeenCalledWith(TELEGRAM_ID, 2_500_000_000);
    expect(wrapSpy).not.toHaveBeenCalled();
    expect(respondSpy).toHaveBeenCalled();
    expect(answerSpy).toHaveBeenCalled();
  });

  test("unwraps when original selection was WSOL even if ticker is normalized", () => {
    const direction = botModule.__test_resolveSolLikeConversionDirection({
      ticker: "SOL",
      mint: "wsol-mint",
      decimals: 9,
      metadata: { selectedTicker: "WSOL" },
    } as any);

    expect(direction).toBe("unwrap");
  });

  test("unwraps when mint is WSOL even without metadata hint", () => {
    const direction = botModule.__test_resolveSolLikeConversionDirection({
      ticker: "SOL",
      mint: WSOL_MINT,
      decimals: 9,
      metadata: {},
    } as any);

    expect(direction).toBe("unwrap");
  });

  test("wraps when selection was SOL", () => {
    const direction = botModule.__test_resolveSolLikeConversionDirection({
      ticker: "SOL",
      mint: "wsol-mint",
      decimals: 9,
      metadata: { selectedTicker: "SOL" },
    } as any);

    expect(direction).toBe("wrap");
  });

  test("wraps when selection was SOL even if ticker is WSOL", () => {
    const direction = botModule.__test_resolveSolLikeConversionDirection({
      ticker: "WSOL",
      mint: WSOL_MINT,
      decimals: 9,
      metadata: { selectedTicker: " SOL  " },
    } as any);

    expect(direction).toBe("wrap");
  });

  test("unwraps when selection was WSOL even if ticker normalizes to SOL", () => {
    const direction = botModule.__test_resolveSolLikeConversionDirection({
      ticker: " sol ",
      mint: "not-wsol",
      decimals: 9,
      metadata: { selectedTicker: "wsol" },
    } as any);

    expect(direction).toBe("unwrap");
  });
});
