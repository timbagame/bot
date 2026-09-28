import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import { botModule, restoreStubs, stub, useBotHarness, wallet } from "./helpers/bot-harness";
import { OracleClient } from "../src/utils/oracle";
import { contractCapabilities } from "../src/utils/contract-idl";
import { DEFAULT_TOKEN_MINT } from "../src/utils/constants";

useBotHarness();

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

let minimumRaw: bigint | number;
let fetchedMints: string[];
let policySpy: ReturnType<typeof mock>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  minimumRaw = 1_500_000;
  fetchedMints = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  // v0.2 reads the per-token account; v0.3 reads the oracle token policy.
  botModule.__test_setProgram({
    programId: (await Keypair.generate()).publicKey,
    account: {
      gameToken: {
        fetch: async () => {
          fetchedMints.push("gameToken");
          return { minAmount: { toString: () => String(minimumRaw) } };
        },
      },
    },
  } as any);
  // Stub the shared instance: other suites assign methods directly on it.
  policySpy = mock(async (mint: string) => {
    fetchedMints.push(mint);
    return { minimumAmountRaw: BigInt(minimumRaw), revision: 3 } as any;
  });
  stub(OracleClient.getInstance(wallet) as any, "requireTokenPolicy", policySpy);
});

afterEach(() => {
  botModule.__test_resetProgram();
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("getTokenPolicyMinimumAmount", () => {
  test("uses the decimals hint to format the on-chain minimum", async () => {
    const minimum = await botModule.getTokenPolicyMinimumAmount(MINT, 6);

    expect(minimum).toEqual({ formatted: 1.5, raw: 1_500_000, decimals: 6 });
    expect(fetchedMints).toEqual(contractCapabilities.gameTokenAccount ? ["gameToken"] : [MINT]);
  });

  test("looks up decimals when no hint is given", async () => {
    stub(wallet, "getTokenMetadata", async () => ({ decimals: 5 }));

    const minimum = await botModule.getTokenPolicyMinimumAmount(MINT);

    expect(minimum.decimals).toBe(5);
    expect(minimum.formatted).toBe(15);
  });

  test("falls back to the default token when the mint's metadata is unavailable", async () => {
    stub(wallet, "getTokenMetadata", async (mint: string) => {
      if (mint === MINT) throw new Error("mint not found");
      return { decimals: 6 };
    });

    const minimum = await botModule.getTokenPolicyMinimumAmount(MINT);

    expect(minimum.decimals).toBe(6);
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      `⚠️ Could not fetch metadata for ${MINT}, falling back to default token metadata`,
    );
    if (!contractCapabilities.gameTokenAccount) {
      expect(fetchedMints).toEqual([DEFAULT_TOKEN_MINT]);
    }
  });

  test.skipIf(contractCapabilities.gameTokenAccount)(
    "rejects oracle minimums beyond the safe integer range",
    async () => {
      minimumRaw = 2n ** 60n;

      await expect(botModule.getTokenPolicyMinimumAmount(MINT, 6)).rejects.toThrow(
        "Token policy minimum exceeds the supported numeric range",
      );
    },
  );
});

describe("checkTokenPolicyStatus", () => {
  test("logs the default token minimum", async () => {
    stub(wallet, "getTokenMetadata", async () => ({ decimals: 6 }));

    await botModule.__test_checkTokenPolicyStatus();

    expect(
      logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("token minimum: 1.5")),
    ).toBe(true);
  });

  test("warns when the default token is not configured on chain", async () => {
    stub(wallet, "getTokenMetadata", async () => ({ decimals: 6 }));
    policySpy.mockRejectedValue(new Error("policy missing"));
    botModule.__test_setProgram({
      programId: (await Keypair.generate()).publicKey,
      account: {
        gameToken: {
          fetch: async () => {
            throw new Error("account missing");
          },
        },
      },
    } as any);

    await botModule.__test_checkTokenPolicyStatus();

    expect(String(warnSpy.mock.calls[0]?.[0])).toStartWith(
      "Default token configuration is unavailable for contract",
    );
  });
});

describe("recoverPendingGameCreations", () => {
  let savedManager: any;
  let recover: ReturnType<typeof mock>;
  let pending: Array<{ game_address: string; chat_id: number }>;

  beforeEach(() => {
    savedManager = botModule.__test_getGameManager();
    pending = Array.from({ length: 6 }, (_, index) => ({
      game_address: `Game${index}`,
      chat_id: -100 - index,
    }));
    botModule.__test_setGameDatabase({
      getPendingGameCreations: () => pending,
    } as any);
    recover = mock(async (_ctx: any, record: { game_address: string }) => {
      if (record.game_address === "Game2") throw new Error("still unconfirmed");
      return record.game_address !== "Game3";
    });
    botModule.__test_setGameManager({ recoverPendingGameCreation: recover } as any);
  });

  afterEach(() => {
    botModule.__test_setGameManager(savedManager);
    botModule.__test_resetGameDatabase();
  });

  test("retries every pending creation in its own chat and logs the outcome", async () => {
    await botModule.__test_recoverPendingGameCreations();

    expect(recover.mock.calls.map((call: any[]) => call[0].chat.id)).toEqual([
      -100, -101, -102, -103, -104, -105,
    ]);
    const logged = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged).toContain("♻️ Recovered confirmed game setup Game0");
    expect(logged).not.toContain("♻️ Recovered confirmed game setup Game3");
    expect(warnSpy).toHaveBeenCalledWith(
      "Pending game setup will be retried for Game2:",
      "still unconfirmed",
    );
  });

  test("a sweep already in progress is not started twice", async () => {
    let release!: () => void;
    recover.mockImplementation(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    );
    pending = pending.slice(0, 1);

    const first = botModule.__test_recoverPendingGameCreations();
    await botModule.__test_recoverPendingGameCreations();
    release();
    await first;

    expect(recover).toHaveBeenCalledTimes(1);
  });

  test("a failing sweep is logged and can run again", async () => {
    botModule.__test_setGameDatabase({
      getPendingGameCreations: () => {
        throw new Error("db locked");
      },
    } as any);

    await botModule.__test_recoverPendingGameCreations();
    expect(errorSpy).toHaveBeenCalledWith("Pending game creation sweep failed", expect.any(Error));

    botModule.__test_setGameDatabase({ getPendingGameCreations: () => [] } as any);
    await botModule.__test_recoverPendingGameCreations();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("non-Error failures are reported as text", async () => {
    recover.mockImplementation(async () => {
      throw "rpc timeout";
    });
    pending = pending.slice(0, 1);

    await botModule.__test_recoverPendingGameCreations();

    expect(warnSpy).toHaveBeenCalledWith(
      "Pending game setup will be retried for Game0:",
      "rpc timeout",
    );
  });
});
