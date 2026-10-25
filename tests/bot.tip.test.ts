import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import {
  bot,
  botModule,
  clearApiOverride,
  overrideApiMethod,
  resetCalls,
  restoreStubs,
  stub,
  texts,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import * as priceService from "../src/utils/price-service";
import { WSOL_MINT } from "../src/utils/constants";

useBotHarness();

const CHAT = -4_300;
const SENDER = 72_001;
const TARGET = 72_002;
const LAMPORTS = 1_000_000_000;
let updateId = 94_000_000;

let savedTokenManager: any;
let savedGameManager: any;
let priceSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let transferSol: ReturnType<typeof mock>;

beforeEach(async () => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  savedTokenManager = botModule.__test_getTokenManager();
  savedGameManager = botModule.__test_getGameManager();
  botModule.__test_setTokenManager({
    parseAmount: async () => ({
      success: true,
      data: {
        amount: 2 * LAMPORTS,
        isSol: true,
        formattedAmount: "2 SOL",
        tokenMint: WSOL_MINT,
        tokenTicker: "SOL",
        decimals: 9,
        tokenWasSpecified: true,
      },
    }),
  } as any);
  botModule.__test_setGameManager({
    findTelegramIdByUsername: () => undefined,
    primeUsernameCache: () => {},
  } as any);
  priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue({ price: 150 } as any);
  const recipientKey = (await Keypair.generate()).publicKey.toBase58();
  const keypair = await Keypair.generate();
  stub(wallet, "getKeyPair", async () => keypair);
  stub(wallet, "getPublicKey", async () => recipientKey);
  stub(wallet, "getBalance", async () => 10 * LAMPORTS);
  transferSol = mock(async () => "sol-sig");
  stub(wallet, "transferSol", transferSol);
});

afterEach(() => {
  botModule.__test_setTokenManager(savedTokenManager);
  botModule.__test_setGameManager(savedGameManager);
  clearApiOverride("getChatMember");
  restoreStubs();
  priceSpy.mockRestore();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

test("a tipped person with no name at all is called User", async () => {
  // Telegram reports neither a first name nor a username for this account.
  overrideApiMethod("getChatMember", (payload) => ({
    status: "member",
    user: { id: payload.user_id, is_bot: false },
  }));
  const text = "/tip 2";

  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "supergroup", title: "Group" },
      from: { id: SENDER, is_bot: false, first_name: "Sender" },
      text,
      entities: [
        { type: "bot_command", offset: 0, length: 4 },
        { type: "text_mention", offset: -1, length: 3, user: { id: TARGET, is_bot: false } },
      ],
    },
  } as any);

  expect(texts()).toContain("⏳ Tip of 2 SOL ($300) to User…");
  expect(transferSol).toHaveBeenCalledTimes(1);
});
