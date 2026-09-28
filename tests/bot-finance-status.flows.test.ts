import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import {
  answers,
  botModule,
  callsTo,
  failApiMethod,
  lastCall,
  press,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import { FinanceLedgerService } from "../src/services/finance-ledger";
import * as contractCapital from "../src/services/contract-capital";
import * as priceService from "../src/utils/price-service";
import { OracleClient } from "../src/utils/oracle";

useBotHarness();

// The finance report is restricted to this admin (see FINANCE_ADMIN_TELEGRAM_IDS).
const ADMIN = 5_162_530;
const TIMBA = "TimbaMint1111111111111111111111111111111111";

let savedTokenManager: any;
let snapshotSpy: ReturnType<typeof spyOn>;
let backfillSpy: ReturnType<typeof spyOn>;
let capitalSpy: ReturnType<typeof spyOn>;
let policiesSpy: ReturnType<typeof spyOn>;
let priceSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const operator = await Keypair.generate();
  stub(wallet, "getOperatorKeypair", async () => operator);
  snapshotSpy = spyOn(FinanceLedgerService.prototype, "getSnapshot").mockResolvedValue({
    gameClaimable: [{ mint: TIMBA, amountRaw: 2_000_000n }],
    swapClaimable: [],
    coverage: "complete",
    backfill: { totalSources: 1, completedSources: 1, processedTransactions: 3, lastError: null },
  } as any);
  backfillSpy = spyOn(FinanceLedgerService.prototype, "backfillNextBatch").mockResolvedValue({
    done: true,
  } as any);
  capitalSpy = spyOn(contractCapital, "getContractCapitalLamports").mockResolvedValue(5_000_000n);
  policiesSpy = spyOn(OracleClient.prototype, "getTokenPolicies").mockResolvedValue([
    { mint: TIMBA } as any,
  ]);
  priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue({ price: 0.5 } as any);
  savedTokenManager = botModule.__test_getTokenManager();
  botModule.__test_setTokenManager({
    autoDiscoverTokenInfo: async (mint: string) =>
      mint === TIMBA ? { ticker: "TIMBA", decimals: 6 } : null,
  } as any);
});

afterEach(() => {
  botModule.__test_setTokenManager(savedTokenManager);
  restoreStubs();
  for (const spy of [snapshotSpy, backfillSpy, capitalSpy, policiesSpy, priceSpy]) {
    spy.mockRestore();
  }
  fetchSpy?.mockRestore();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const settle = () => Bun.sleep(20);

describe("/finance", () => {
  test("is silently ignored for other users", async () => {
    await sendText("/finance", { userId: ADMIN + 1 });
    await settle();

    expect(callsTo("sendMessage")).toHaveLength(0);
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  test("builds the report in the background with priced claimable fees", async () => {
    await sendText("/finance", { userId: ADMIN });
    await settle();

    expect(callsTo("sendMessage")[0]?.payload.text).toBe(
      "⏳ Building the finance report. You can continue using the bot.",
    );
    const report = lastCall("editMessageText")!.payload.text as string;
    expect(report).toContain("TIMBA");
    expect(priceSpy).toHaveBeenCalledWith({ tokenMint: TIMBA });
    expect(capitalSpy).toHaveBeenCalledTimes(1);
    const policyMints = capitalSpy.mock.calls[0]?.[2];
    expect(policyMints).toEqual(policiesSpy.mock.calls.length > 0 ? [TIMBA] : []);
  });

  test("tokens without metadata or price are still reported", async () => {
    botModule.__test_setTokenManager({ autoDiscoverTokenInfo: async () => null } as any);
    priceSpy.mockResolvedValue(null as any);

    await sendText("/finance", { userId: ADMIN });
    await settle();

    expect(callsTo("editMessageText")).toHaveLength(1);
  });

  test("failing to send the loading message is a command error", async () => {
    failApiMethod("sendMessage", "Forbidden: bot was blocked by the user", 403);

    await sendText("/finance", { userId: ADMIN });

    expect(errorSpy).toHaveBeenCalledWith("Error in finance command:", expect.anything());
  });

  test("period buttons refresh the report in place", async () => {
    await press("finance:7d", { userId: ADMIN });
    await settle();

    expect(answers()).toContain("Refreshing finance report…");
    expect(lastCall("editMessageText")!.payload.text).toContain("TIMBA");
  });
});

describe("finance ledger wiring", () => {
  test("the backfill worker indexes the last 90 days", async () => {
    await botModule.__test_financeBackfillWorker.runOnce();

    const startTime = backfillSpy.mock.calls[0]?.[0] as number;
    const ninetyDays = 90 * 86_400_000;
    expect(Math.abs(Date.now() - ninetyDays - startTime)).toBeLessThan(10 * 60_000);
  });

  test("completed games resolve their token mint from the game database", async () => {
    const service: any = await botModule.__test_getFinanceLedgerService();
    const gameDb = botModule.__test_getGameDatabase();
    stub(gameDb as any, "getGame", (address: string) =>
      address === "KnownGame" ? { token_mint: TIMBA } : null,
    );

    expect(service.resolveGameMint("KnownGame")).toBe(TIMBA);
    expect(service.resolveGameMint("UnknownGame")).toBeUndefined();
    // The ledger service is created once and reused.
    expect(await botModule.__test_getFinanceLedgerService()).toBe(service);
  });
});

describe("/status", () => {
  const originalNetwork = process.env["SOLANA_NETWORK"];

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 123 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as any,
    );
  });

  afterEach(() => {
    if (originalNetwork === undefined) Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    else process.env["SOLANA_NETWORK"] = originalNetwork;
  });

  const statusText = () => lastCall("sendMessage")?.payload.text as string | undefined;

  test("admins get a health report probing the configured endpoints", async () => {
    process.env["SOLANA_NETWORK"] = "https://rpc-a.example,https://rpc-b.example";

    await sendText("/status", { userId: ADMIN });

    const text = statusText()!;
    expect(text).toContain("rpc-a.example");
    expect(text).toContain("rpc-b.example");
    // The wallet's active endpoint is listed even when not configured.
    expect(text).toContain(new URL(wallet.getConnection().rpcEndpoint).host);
  });

  test("an unparsable SOLANA_NETWORK still reports the active endpoint", async () => {
    process.env["SOLANA_NETWORK"] = "[not json]";

    await sendText("/status", { userId: ADMIN });

    expect(
      warnSpy.mock.calls.some(
        (call: unknown[]) => call[0] === "Unable to parse SOLANA_NETWORK for /status:",
      ),
    ).toBe(true);
    expect(statusText()).toContain(new URL(wallet.getConnection().rpcEndpoint).host);
  });

  test("the active endpoint is not duplicated when it is configured", async () => {
    process.env["SOLANA_NETWORK"] = wallet.getConnection().rpcEndpoint;

    await sendText("/status", { userId: ADMIN });

    const host = new URL(wallet.getConnection().rpcEndpoint).host;
    expect(statusText()!.split(host).length - 1).toBe(1);
  });

  test("other users get no reply", async () => {
    await sendText("/status", { userId: ADMIN + 1 });
    expect(callsTo("sendMessage")).toHaveLength(0);
  });

  test("a failed reply is reported as a command error", async () => {
    failApiMethod("sendMessage", "Forbidden: bot was blocked by the user", 403);

    await sendText("/status", { userId: ADMIN });

    expect(errorSpy).toHaveBeenCalledWith("Error in status command:", expect.anything());
  });
});

describe("/oracle", () => {
  afterEach(() => {
    botModule.__test_resetProgram();
  });

  test("shows the fee, timeouts and player limits from the oracle account", async () => {
    const operator = (await Keypair.generate()).publicKey;
    const fetched: unknown[] = [];
    botModule.__test_setProgram({
      programId: (await Keypair.generate()).publicKey,
      account: {
        oracle: {
          fetch: async (pda: unknown) => {
            fetched.push(pda);
            return {
              feePercentage: 5,
              minTimeout: 300,
              maxTimeout: 86_400,
              maxTickets: 50,
              oracleBufferTime: 60,
              operator,
            };
          },
        },
      },
    } as any);

    const id = await sendText("/oracle", { userId: ADMIN + 7 });

    const reply = lastCall("sendMessage")!;
    expect(reply.payload.reply_to_message_id).toBe(id);
    expect(reply.payload.text).toContain("💸 Fee: 5% of each prize pool");
    expect(reply.payload.text).toContain("👥 Max players: 50");
    expect(reply.payload.text).toContain("⏱️ Game timeout: 5m to 1d");
    expect(reply.payload.text).toContain(`Oracle: <code>${operator.toBase58()}</code>`);
    expect(fetched).toHaveLength(1);
  });

  test("a failed oracle fetch is reported as a command error", async () => {
    botModule.__test_setProgram({
      programId: (await Keypair.generate()).publicKey,
      account: {
        oracle: {
          fetch: async () => {
            throw new Error("Account does not exist");
          },
        },
      },
    } as any);

    await sendText("/oracle", { userId: ADMIN + 7 });

    expect(errorSpy).toHaveBeenCalledWith("Error in oracle command:", expect.any(Error));
  });
});
