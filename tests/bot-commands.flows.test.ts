import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { Keypair } from "#solana";
import {
  botModule,
  lastText,
  messageCalls,
  messageText,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  texts,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import { buyAlertStartPayload } from "../src/services/buy-alerts/keyboard";
import { WSOL_MINT } from "../src/utils/constants";

useBotHarness();

let USER = 61_000;
const LAMPORTS = 1_000_000_000;
let recipient: string;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let savedTokenManager: any;
let parseResult: any;

beforeEach(async () => {
  USER += 1;
  resetCalls();
  recipient = (await Keypair.generate()).publicKey.toBase58();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  savedTokenManager = botModule.__test_getTokenManager();
  parseResult = {
    success: true,
    data: {
      amount: 2 * LAMPORTS,
      isSol: true,
      formattedAmount: "2 SOL",
      tokenMint: WSOL_MINT,
      tokenTicker: "SOL",
      tokenWasSpecified: true,
    },
  };
  botModule.__test_setTokenManager({
    parseAmount: async () => parseResult,
    resolveSwapToken: async (mint: string) => ({
      token_mint: mint,
      token_ticker: "BONK",
      decimals: 5,
    }),
    getAllKnownTokensWithMetadata: () => [],
    resolveGameTokenContext: async (_chat: number, token: string) =>
      token === "BONK"
        ? { success: true, tokenMint: "BonkMint", tokenTicker: "BONK", decimals: 5 }
        : { success: false },
  } as any);
  stub(wallet, "getBalance", async () => 5 * LAMPORTS);
  stub(wallet, "getTokenBalance", async () => 10_000_000);
});

afterEach(() => {
  botModule.__test_setTokenManager(savedTokenManager);
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("/withdraw", () => {
  const withdraw = (args: string) => sendText(`/withdraw ${args}`.trim(), { userId: USER });

  test("explains usage and rejects invalid addresses", async () => {
    await withdraw("");
    expect(lastText()).toContain("Usage: /withdraw &lt;address&gt; &lt;amount&gt;");

    await withdraw("not-an-address 1");
    expect(lastText()).toBe("Invalid wallet address. Please provide a valid Solana address.");
  });

  test("all/max only works for SOL", async () => {
    await withdraw(`${recipient} all BONK`);
    expect(lastText()).toContain("`all` is only supported for SOL");
  });

  test("withdrawing everything with no SOL is refused", async () => {
    stub(wallet, "getBalance", async () => 0);
    await withdraw(`${recipient} max`);
    expect(lastText()).toBe("Your wallet has no SOL available to withdraw.");
  });

  test("withdraws the whole SOL balance with a Solscan link", async () => {
    const withdrawAll = mock(async () => ({
      signature: "all-sig",
      totalLamportsSent: 4 * LAMPORTS,
    }));
    stub(wallet, "withdrawAllSol", withdrawAll);

    await withdraw(`${recipient} ALL sol`);

    expect(String((withdrawAll.mock.calls[0] as any[])[1])).toBe(recipient);
    expect(texts()).toContain("⏳ SOL withdrawal…");
    expect(lastText()).toContain("4 SOL is on its way.");
  });

  test("reports a failed full withdrawal", async () => {
    stub(wallet, "withdrawAllSol", async () => {
      throw new Error("rpc down");
    });

    await withdraw(`${recipient} all`);

    expect(
      errorSpy.mock.calls.some((call: unknown[]) => call[0] === "Error in withdraw command:"),
    ).toBe(true);
  });

  test("rejects an amount that cannot be parsed", async () => {
    parseResult = { success: false, error: "invalid_amount" };
    await withdraw(`${recipient} lots`);
    expect(lastText()).toContain("Please provide a valid amount greater than 0.");
  });

  test("sends SOL amounts natively", async () => {
    const transferSol = mock(async () => "sol-sig");
    stub(wallet, "transferSol", transferSol);

    await withdraw(`${recipient} 2 SOL`);

    expect((transferSol.mock.calls[0] as any[])[2]).toBe(2 * LAMPORTS);
    expect(lastText()).toContain("✅ Withdrawal of 2 SOL sent");
  });

  test("mainnet withdrawals link to the transaction on Solscan", async () => {
    const original = process.env["RPC_URL"];
    process.env["RPC_URL"] = "https://api.mainnet-beta.solana.com";
    stub(wallet, "transferSol", async () => "mainnet-sig");
    try {
      await withdraw(`${recipient} 2 SOL`);
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, "RPC_URL");
      else process.env["RPC_URL"] = original;
    }

    expect(lastText()).toContain("✅ Withdrawal of 2 SOL sent");
    expect(lastText()).toContain("🔗 View transaction");
    expect(lastText()).toContain("mainnet-sig");
  });

  test("sends token amounts and reports shortfalls by ticker", async () => {
    parseResult = {
      success: true,
      data: {
        amount: 5_000_000,
        isSol: false,
        formattedAmount: "50 BONK",
        tokenMint: "BonkMint",
        tokenTicker: "BONK",
        tokenWasSpecified: true,
      },
    };
    const transferToken = mock(async () => "token-sig");
    stub(wallet, "transferToken", transferToken);

    await withdraw(`${recipient} 50 BONK`);
    expect((transferToken.mock.calls[0] as any[]).slice(2)).toEqual([5_000_000, "BonkMint"]);

    stub(wallet, "getTokenBalance", async () => 1);
    await withdraw(`${recipient} 50 BONK`);
    expect(lastText()).toBe("❌ Not enough BONK. Deposit more with /deposit or lower the amount.");
  });

  test("a failed transfer is reported", async () => {
    stub(wallet, "transferSol", async () => {
      throw new Error("Jupiter error: no route found");
    });

    await withdraw(`${recipient} 2`);

    expect(messageCalls().some((call) => messageText(call).includes("No swap route"))).toBe(true);
  });
});

describe("/start buy-alert deep links", () => {
  test("opens the swap screen for the alerted token in private chats", async () => {
    stub(wallet, "getAllWalletTokenBalances", async () => []);

    await sendText(
      `/start ${buyAlertStartPayload("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")}`,
      { userId: USER },
    );

    expect(lastText()).toContain("💱 <b>Swap Amount</b>");
    expect(lastText()).toContain("<b>To:</b> BONK");
  });

  test("explains when the token cannot be bought", async () => {
    await sendText(`/start ${buyAlertStartPayload(WSOL_MINT)}`, { userId: USER });
    expect(lastText()).toBe("This token isn't available to buy here.");
  });
});

describe("/cf error handling", () => {
  test("apologises when the coinflip handler throws", async () => {
    const game = await import("../src/handlers/game");
    const spy = spyOn(game, "handleCoinflipCommand").mockImplementation((async () => {
      throw new Error("boom");
    }) as any);
    try {
      await sendText("/cf", { userId: USER, chatId: -USER });
    } finally {
      spy.mockRestore();
    }

    expect(lastText()).toBe("❌ Error setting up coinflip game. Please try again.");
  });
});

describe("EVM integration hooks", () => {
  test("maps Solana chat defaults onto EVM games", () => {
    const chatDb = botModule.__test_getChatDatabase();
    chatDb.upsertChatGameSettings(-USER, { giveaway_max_players: 12, timeout_seconds: 900 });

    expect(botModule.__test_evmGameDefaults(-USER, "giveaway")).toMatchObject({
      maxPlayers: 12,
      timeout: 900,
    });
    expect(botModule.__test_evmGameDefaults(-USER - 1, "coinflip").maxPlayers).toBe(2);
  });

  test("resolves Solana tokens for the EVM token prompt", async () => {
    expect(await botModule.__test_resolveEvmSolanaToken("BONK", -1)).toEqual({
      address: "BonkMint",
      symbol: "BONK",
    });
    expect(await botModule.__test_resolveEvmSolanaToken("NOPE", -1)).toBeNull();
  });

  test("dispatches game commands back to the Solana handlers", async () => {
    const coinflip = { message: { text: "/coinflip@bot 5" } } as any;
    const giveaway = { message: { text: "/ga 5" } } as any;
    const handled: string[] = [];
    const game = await import("../src/handlers/game");
    const spy = spyOn(game, "handleCoinflipCommand").mockImplementation((async () => {
      handled.push("coinflip");
    }) as any);
    try {
      await botModule.__test_dispatchSolanaGameCommand(coinflip);
    } finally {
      spy.mockRestore();
    }
    expect(handled).toEqual(["coinflip"]);
    await botModule.__test_dispatchSolanaGameCommand(giveaway).catch(() => {});
  });

  test("the EVM runtime is only created when configured", () => {
    expect(botModule.createEvmRuntime(new Bot("1:x"), undefined)).toBeUndefined();

    const folder = mkdtempSync(join(tmpdir(), "evm-runtime-"));
    writeFileSync(join(folder, "token"), "t", { mode: 0o600 });
    writeFileSync(
      join(folder, "config.json"),
      JSON.stringify({
        chainId: 31337,
        address: `0x${"11".repeat(20)}`,
        version: "0.1.0",
        name: "Anvil",
        rpcUrls: ["http://127.0.0.1:1"],
        oracleUrl: "http://127.0.0.1:1",
        oracleTokenFile: join(folder, "token"),
        database: join(folder, "db.sqlite"),
        webUrl: "http://localhost/",
        confirmations: 2,
      }),
    );
    const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation((() => ({
      unref() {},
    })) as any);
    try {
      const runtime = botModule.createEvmRuntime(new Bot("1:x"), join(folder, "config.json"))!;
      expect(runtime.network(-1).name).toBe("Anvil");
      runtime.stop();
      runtime.service.store.close();
    } finally {
      intervalSpy.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
