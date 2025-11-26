import { describe, expect, test, vi, beforeEach, afterEach } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";

import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import { WSOL_MINT } from "../src/utils/token-registry";

describe("SwapManager.getQuote SOL/WSOL handling", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = WalletManager.createForTest(
    "test walk nut penalty hip pave soap entry language right filter choice",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  const user = Keypair.generate();
  const baseRequest = {
    amount: "123000000",
    inputDecimals: 9,
    outputDecimals: 9,
    userKeypair: user,
  } as const;

  let manager: SwapManager;
  let networkEnv: string | undefined;
  let hadNetworkEnv = false;

  beforeEach(() => {
    hadNetworkEnv = "SOLANA_NETWORK" in process.env;
    networkEnv = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
    manager = new SwapManager(connection, wallet);
  });

  afterEach(() => {
    if (hadNetworkEnv) {
      process.env.SOLANA_NETWORK = networkEnv!;
    } else {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    }
    vi.restoreAllMocks();
  });

  test("returns synthetic wrap quote without calling Jupiter", async () => {
    const jupiterSpy = vi
      .spyOn((manager as any).jupiterClient, "getQuote")
      .mockResolvedValue(null as any);

    const quote = await manager.getQuote({
      ...baseRequest,
      inputMint: WSOL_MINT,
      outputMint: WSOL_MINT,
      inputTicker: "SOL",
      outputTicker: "WSOL",
      integrator: {
        payerKind: "admin",
        payer: "ADMIN",
        closeAuthority: "ADMIN_CLOSE",
        referralAccount: "REF",
        referralFee: 50,
      },
    });

    expect(quote.provider).toBe("wrap");
    expect(quote.inputAmount).toBe(baseRequest.amount);
    expect(quote.outputAmount).toBe(baseRequest.amount);
    expect(quote.slippage).toBe(0);
    expect(quote.integrator).toBeNull();
    expect(quote.integratorApplied).toBe(false);
    expect(jupiterSpy).not.toHaveBeenCalled();
  });

  test("returns synthetic unwrap quote without calling Jupiter", async () => {
    const jupiterSpy = vi
      .spyOn((manager as any).jupiterClient, "getQuote")
      .mockResolvedValue(null as any);

    const quote = await manager.getQuote({
      ...baseRequest,
      inputMint: WSOL_MINT,
      outputMint: WSOL_MINT,
      inputTicker: "WSOL",
      outputTicker: "SOL",
      integrator: {
        payerKind: "admin",
        payer: "ADMIN",
        closeAuthority: "ADMIN_CLOSE",
        referralAccount: "REF",
        referralFee: 50,
      },
    });

    expect(quote.provider).toBe("unwrap");
    expect(quote.inputAmount).toBe(baseRequest.amount);
    expect(quote.outputAmount).toBe(baseRequest.amount);
    expect(quote.slippage).toBe(0);
    expect(quote.integrator).toEqual({
      payerKind: "admin",
      payer: "ADMIN",
      closeAuthority: "ADMIN_CLOSE",
      referralAccount: "REF",
      referralFee: 0,
    });
    expect(quote.integratorApplied).toBe(false);
    expect(jupiterSpy).not.toHaveBeenCalled();
  });

  test("still requests Jupiter quote for non wrap/unwrap pairs", async () => {
    const jupiterSpy = vi
      .spyOn((manager as any).jupiterClient, "getQuote")
      .mockResolvedValue({
        inputMint: WSOL_MINT,
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: baseRequest.amount,
        outAmount: "1000",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
      });

    const quote = await manager.getQuote({
      ...baseRequest,
      inputMint: WSOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputTicker: "SOL",
      outputTicker: "USDC",
    });

    expect(quote.provider).toBe("jupiter");
    expect(jupiterSpy).toHaveBeenCalledTimes(1);
    const [params] = jupiterSpy.mock.calls[0]!;
    expect(params).toMatchObject({
      inputMint: WSOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: baseRequest.amount,
    });
  });
});
