import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import {
  botModule,
  clearApiOverride,
  lastText,
  overrideApiMethod,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  texts,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import { OracleClient } from "../src/utils/oracle";

useBotHarness();

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
let GROUP = -8_800;
let USER = 88_000;

let savedTokenManager: any;
let savedManager: any;
let manager: any;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  GROUP -= 1;
  USER += 1;
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  savedTokenManager = botModule.__test_getTokenManager();
  botModule.__test_setTokenManager({
    parseAmount: async () => ({
      success: true,
      data: {
        amount: 500_000,
        isSol: false,
        formattedAmount: "5 BONK",
        tokenMint: BONK,
        tokenTicker: "BONK",
        decimals: 5,
        tokenWasSpecified: true,
      },
    }),
    resolveGameTokenContext: async () => ({ success: false }),
    getChatDefaultToken: () => null,
  } as any);
  stub(wallet, "getTokenMetadata", async () => ({ decimals: 5 }));
  stub(wallet, "getTokenBalance", async () => 10_000_000);
  // The minimum comes from the per-token account (v0.2) or the oracle policy (v0.3).
  botModule.__test_setProgram({
    programId: (await Keypair.generate()).publicKey,
    account: { gameToken: { fetch: async () => ({ minAmount: 100_000 }) } },
  } as any);
  stub(OracleClient.getInstance(wallet) as any, "requireTokenPolicy", async () => ({
    minimumAmountRaw: 100_000n,
    revision: 1,
  }));
  savedManager = botModule.__test_getGameManager();
  manager = {
    hasGameCreationRequest: mock(() => false),
    createGame: mock(async () => ({
      success: false,
      confirmedSignature: "confirmed-sig",
      gameAddress: "ConfirmedGame",
      error: "message send failed",
    })),
    ownsPendingCreationMessage: mock(() => true),
    recoverPendingGameCreationByAddress: mock(async () => true),
    clearPendingGameCreation: mock(() => undefined),
  };
  botModule.__test_setGameManager(manager as any);
});

afterEach(() => {
  botModule.__test_setTokenManager(savedTokenManager);
  botModule.__test_setGameManager(savedManager);
  botModule.__test_resetProgram();
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("/coinflip through the bot", () => {
  test("a confirmed game whose card failed is handed to recovery with its placeholder", async () => {
    const getTokenBalance = mock(async () => 10_000_000);
    stub(wallet, "getTokenBalance", getTokenBalance);

    await sendText("/cf 5 BONK 2", { userId: USER, chatId: GROUP });

    expect((getTokenBalance.mock.calls[0] as any[]).slice(0, 2)).toEqual([BigInt(USER), BONK]);
    const [gameType, tokenArgs, maxPlayers] = manager.createGame!.mock.calls[0] as any[];
    expect(gameType).toBe("coinflip");
    expect(tokenArgs).toMatchObject({ amount: 500_000, tokenMint: BONK, tokenTicker: "BONK" });
    expect(maxPlayers).toBe(2);
    const creationMessage = texts().indexOf("⏳ Creating game…");
    expect(creationMessage).toBeGreaterThanOrEqual(0);
    const [address, chatId] = manager.ownsPendingCreationMessage!.mock.calls[0] as any[];
    expect([address, chatId]).toEqual(["ConfirmedGame", GROUP]);
    expect(manager.recoverPendingGameCreationByAddress).toHaveBeenCalled();
  });

  test("amounts below the token minimum are refused", async () => {
    botModule.__test_setTokenManager({
      ...(botModule.__test_getTokenManager() as any),
      parseAmount: async () => ({
        success: true,
        data: {
          amount: 10,
          isSol: false,
          formattedAmount: "0.0001 BONK",
          tokenMint: BONK,
          tokenTicker: "BONK",
          decimals: 5,
          tokenWasSpecified: true,
        },
      }),
    } as any);

    await sendText("/cf 0.0001 BONK", { userId: USER, chatId: GROUP });

    expect(lastText()).toBe("❌ Amount below current minimum of 1 BONK.");
    expect(manager.createGame).not.toHaveBeenCalled();
  });

  test("an unknown token for the setup menu is reported", async () => {
    await sendText("/cf NOPE", { userId: USER, chatId: GROUP });

    expect(lastText()).toBe("Token unavailable. Check its symbol or address.");
  });
});

describe("/coinflip naming who to challenge through the bot", () => {
  afterEach(() => clearApiOverride("getChatMember"));

  test("a saved @display name cannot become a challenge target", async () => {
    const db = botModule.__test_getGameDatabase();
    db.savePlayerMapping("fictional-cf-impersonator", "5151", "@cf_impersonated");
    manager.findTelegramIdByUsername = db.findTelegramIdByUsername.bind(db);

    await sendText("/cf 5 BONK @cf_impersonated", { userId: USER, chatId: GROUP });

    expect(lastText()).toBe(
      "I don't know who <code>@cf_impersonated</code> is. Reply to one of their messages to challenge them.",
    );
    expect(manager.createGame).not.toHaveBeenCalled();
  });

  test("a known @username is challenged one on one, privately", async () => {
    manager.findTelegramIdByUsername = mock(() => "5150");
    overrideApiMethod("getChatMember", (payload) => ({
      status: "member",
      user: { id: payload.user_id, is_bot: false, first_name: "Rival", username: "rival" },
    }));

    await sendText("/cf 5 BONK @rival", { userId: USER, chatId: GROUP });

    expect(manager.findTelegramIdByUsername).toHaveBeenCalledWith("@rival");
    const call = manager.createGame!.mock.calls[0] as any[];
    expect(call[2]).toBe(2);
    expect(call[6]).toMatchObject({
      isPrivate: true,
      challenge: { telegramId: "5150", displayName: "@rival" },
    });
  });

  test("a failed read is answered as such and opens nothing", async () => {
    manager.findTelegramIdByUsername = mock(() => {
      throw new Error("synthetic-db-down");
    });

    await sendText("/cf 5 BONK @rival", { userId: USER, chatId: GROUP });

    expect(lastText()).toBe(
      "I couldn't look up <code>@rival</code>. Try again, or reply to one of their messages.",
    );
    expect(manager.createGame).not.toHaveBeenCalled();
  });
});
