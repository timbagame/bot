import { Buffer } from "buffer";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, TransactionMessage, VersionedTransaction } from "#solana";
import { JupiterReferralUnavailableError } from "../src/utils/jupiter";
import { SOL, createManager } from "./helpers/swap-manager-fixtures";

const serializeTx = (payer: Keypair): string => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
};

const OUT_AMOUNT = "10000000";

type Setup = Awaited<ReturnType<typeof setup>>;

const setup = async (
  options: {
    operatorIsPayer?: boolean;
    integratorOverrides?: Record<string, unknown>;
    orderOverrides?: Record<string, unknown> | null;
    txPayer?: "admin" | "user";
    outputMint?: string;
    balance?: number;
    withProviderQuote?: boolean;
  } = {},
) => {
  const user = await Keypair.generate();
  const admin = await Keypair.generate();
  const operator = options.operatorIsPayer === false ? await Keypair.generate() : admin;
  const tokenMint = (await Keypair.generate()).publicKey.toBase58();
  const outputMint = options.outputMint ?? SOL;
  const { manager } = createManager({ operator, balance: options.balance ?? 100_000_000 });
  manager.createTokenAccountsIfNeeded = async () => [];

  const integrator = {
    referralAccount: (await Keypair.generate()).publicKey.toBase58(),
    referralFee: 120,
    payer: admin.publicKey.toBase58(),
    closeAuthority: admin.publicKey.toBase58(),
    payerKind: "admin" as const,
    ...options.integratorOverrides,
  };
  const order =
    options.orderOverrides === null
      ? undefined
      : {
          mode: "ExactIn",
          inputMint: tokenMint,
          outputMint: SOL,
          inAmount: "1000000",
          outAmount: OUT_AMOUNT,
          otherAmountThreshold: "0",
          swapMode: "ExactIn",
          slippageBps: 100,
          routePlan: [],
          feeMint: SOL,
          platformFee: { amount: "1000", feeBps: 120, feeMint: SOL },
          signatureFeeLamports: 5000,
          prioritizationFeeLamports: 0,
          rentFeeLamports: 0,
          requestId: "order-req",
          router: "iris",
          ...options.orderOverrides,
        };
  const providerQuote = {
    inputMint: tokenMint,
    outputMint,
    inAmount: "1000000",
    outAmount: OUT_AMOUNT,
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 100,
    priceImpactPct: "0",
    routePlan: [],
  };
  const quote: any = {
    inputMint: tokenMint,
    outputMint,
    inputAmount: "1000000",
    inputAmountRaw: "1000000",
    outputAmount: OUT_AMOUNT,
    estimatedRate: 10,
    slippage: 1,
    provider: "jupiter" as const,
    providerQuote: options.withProviderQuote === false ? undefined : providerQuote,
    providerQuoteTimestamp: Date.now(),
    integrator,
  };
  const request = {
    inputMint: tokenMint,
    outputMint,
    amount: "1000000",
    userKeypair: user,
    inputDecimals: 6,
    outputDecimals: 9,
    inputTicker: "TKN",
    outputTicker: "SOL",
    integrator,
  };
  const txPayer = options.txPayer === "user" ? user : admin;
  manager.jupiterClient.getSwapTransaction = async () => ({
    swapTransaction: serializeTx(txPayer),
    requestId: "swap-req",
    quoteId: "quote-id",
    router: "iris",
    order,
  });
  const executeCalls: any[][] = [];
  manager.executeJupiterTransaction = async (...args: any[]) => {
    executeCalls.push(args);
    return "SIG_OK";
  };
  return { manager, user, admin, operator, quote, request, integrator, executeCalls, order };
};

describe("SwapManager.executeJupiterSwap admin payer flow", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const run = (s: Setup) => s.manager.executeJupiterSwap(s.request, s.quote);

  test("signs with user and operator and records execution accounting", async () => {
    const s = await setup();

    const signature = await run(s);

    expect(signature).toBe("SIG_OK");
    expect(s.executeCalls).toHaveLength(1);
    const [, requestId, signers, expectedPayer] = s.executeCalls[0]!;
    expect(requestId).toBe("swap-req");
    expect(signers).toEqual([s.user, s.operator]);
    expect(expectedPayer).toBe(s.integrator.payer);
    expect(s.quote.executionFeeBps).toBe(120);
    expect(s.quote.executionFeeMint).toBe(SOL);
    expect(s.quote.executionReferralApplied).toBe(true);
    expect(s.quote.executionOutputAmount).toBe(OUT_AMOUNT);
    expect(s.integrator).toHaveProperty("adminRouteLamports", 5000);
  });

  test("logs a rent-shortage execution failure with the route context", async () => {
    const s = await setup({
      orderOverrides: { rentFeeLamports: 2_000, prioritizationFeeLamports: 300 },
    });
    s.manager.executeJupiterTransaction = async () => {
      throw new Error("Transaction simulation failed: insufficient funds for rent");
    };

    await expect(run(s)).rejects.toThrow("insufficient funds for rent");

    const call = errorSpy.mock.calls.find(
      (args: unknown[]) => args[0] === "Jupiter execution failed for rent shortage",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      error: "Transaction simulation failed: insufficient funds for rent",
      jupiterRequestId: "swap-req",
      jupiterQuoteId: "quote-id",
      router: "iris",
      orderRouter: "iris",
      orderRequestId: "order-req",
      orderRouteLamports: 7300,
      adminRouteLamports: 7300,
    });
  });

  test("logs other execution failures with the generic label", async () => {
    const s = await setup({ orderOverrides: null, integratorOverrides: { payerKind: "user" } });
    s.manager.jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: serializeTx(s.user),
      requestId: "swap-req",
      order: { platformFee: { feeBps: 150 } },
    });
    s.manager.executeJupiterTransaction = async () => {
      throw new Error("blockhash expired");
    };

    await expect(run(s)).rejects.toThrow("blockhash expired");

    const call = errorSpy.mock.calls.find(
      (args: unknown[]) => args[0] === "Jupiter execution failed",
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ error: "blockhash expired", orderRouteLamports: 0 });
  });

  test("rejects a loaded operator that is not the integrator payer", async () => {
    const s = await setup({ operatorIsPayer: false });

    await expect(run(s)).rejects.toThrow(
      `Integrator requires admin payer ${s.integrator.payer} / closeAuthority ${s.integrator.closeAuthority}, but loaded operator keypair is ${s.operator.publicKey.toBase58()}`,
    );
    expect(s.executeCalls).toHaveLength(0);
  });

  test("rejects a close authority that differs from the operator", async () => {
    const otherClose = (await Keypair.generate()).publicKey.toBase58();
    const s = await setup({ integratorOverrides: { closeAuthority: otherClose } });

    await expect(run(s)).rejects.toThrow(`closeAuthority ${otherClose}`);
    expect(s.executeCalls).toHaveLength(0);
  });

  test("refuses when the admin wallet cannot cover the route", async () => {
    const s = await setup({ balance: 10 });

    await expect(run(s)).rejects.toThrow(/Admin wallet .* cannot cover rent\+priority/);
    expect(s.executeCalls).toHaveLength(0);
  });

  test("rejects sponsored swaps whose fee does not recover the sponsor cost", async () => {
    const s = await setup({
      integratorOverrides: { referralFee: 100 },
      orderOverrides: { platformFee: { amount: "1", feeBps: 100, feeMint: SOL } },
    });

    await expect(run(s)).rejects.toThrow(
      "This trade cannot cover the operator's 105 bps sponsor cost with the confirmed 100 bps fee.",
    );
    expect(s.executeCalls).toHaveLength(0);
  });

  test("tells the user to re-quote when a sponsored route lost its admin payer", async () => {
    const s = await setup({ txPayer: "user" });

    await expect(run(s)).rejects.toThrow(
      "The sponsored route changed. Request a new quote before confirming.",
    );
  });

  test("treats a Jupiter integrator fallback order as a changed sponsored route", async () => {
    const s = await setup({ orderOverrides: { integratorFallback: true } });

    await expect(run(s)).rejects.toThrow(
      "The sponsored route changed. Request a new quote before confirming.",
    );
  });

  test("refuses a fee-free fallback when the payer key is not a valid public key", async () => {
    const s = await setup({ integratorOverrides: { payer: "not-a-public-key" } });

    await expect(run(s)).rejects.toThrow(
      "Jupiter could not apply the required swap fee and admin payer; refusing a fee-free fallback.",
    );
  });

  test("refuses a fee-free fallback when the payer key is empty", async () => {
    const s = await setup({ integratorOverrides: { payer: "" } });

    await expect(run(s)).rejects.toThrow(
      "Jupiter could not apply the required swap fee and admin payer; refusing a fee-free fallback.",
    );
  });

  test("does not offer the atomic fallback for routes that do not output SOL", async () => {
    const outputMint = (await Keypair.generate()).publicKey.toBase58();
    const s = await setup({ txPayer: "user", outputMint });

    await expect(run(s)).rejects.toThrow(
      "Jupiter could not apply the required swap fee and admin payer; refusing a fee-free fallback.",
    );
  });

  test("rejects an unreadable swap transaction when checking the admin fee payer", async () => {
    const s = await setup();
    s.manager.jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: "not-base64-!!",
      requestId: "swap-req",
      order: s.order,
    });

    await expect(run(s)).rejects.toThrow("Jupiter returned an invalid serialized transaction.");
  });

  test("rejects non-admin swaps when Jupiter does not confirm the integrator fee", async () => {
    const s = await setup({
      integratorOverrides: { payerKind: "user", referralFee: 150 },
      orderOverrides: { platformFee: { feeBps: 120 } },
      txPayer: "user",
    });

    await expect(run(s)).rejects.toThrow(
      "Jupiter did not confirm the required 150 bps swap fee; refusing execution.",
    );
    expect(s.executeCalls).toHaveLength(0);
  });

  test("refreshes a missing provider quote with the cached integrator parameters", async () => {
    const s = await setup({
      withProviderQuote: false,
      integratorOverrides: { payerKind: "user", referralFee: 150 },
      orderOverrides: { platformFee: { feeBps: 120 } },
      txPayer: "user",
    });
    const refreshCalls: any[] = [];
    s.manager.getJupiterQuote = async (params: any) => {
      refreshCalls.push(params);
      return { ...s.quote, inAmount: "1000000", outAmount: OUT_AMOUNT };
    };

    await expect(run(s)).rejects.toThrow("required 150 bps");

    expect(refreshCalls).toEqual([
      {
        inputMint: s.quote.inputMint,
        outputMint: SOL,
        amount: "1000000",
        taker: s.user.publicKey.toBase58(),
        referralAccount: s.integrator.referralAccount,
        referralFee: 150,
        payer: s.integrator.payer,
        closeAuthority: s.integrator.closeAuthority,
      },
    ]);
  });

  describe("when Jupiter reports the referral account as unavailable", () => {
    test("asks for a new quote if the failed sponsored route used the operator payer", async () => {
      const s = await setup();
      const cause = new JupiterReferralUnavailableError("referral gone");
      s.manager.jupiterClient.getSwapTransaction = async () => {
        throw cause;
      };

      const error = await run(s).catch((e: unknown) => e as Error);

      expect(error.message).toBe(
        "The sponsored route changed. Request a new quote before confirming.",
      );
      expect(error.cause).toBe(cause);
    });

    test("rethrows the original error when the payer is not the operator", async () => {
      const s = await setup({ operatorIsPayer: false });
      const cause = new JupiterReferralUnavailableError("referral gone");
      s.manager.jupiterClient.getSwapTransaction = async () => {
        throw cause;
      };

      expect(await run(s).catch((e: unknown) => e)).toBe(cause);
    });

    test("rethrows unrelated errors untouched", async () => {
      const s = await setup();
      const failure = new Error("network down");
      s.manager.jupiterClient.getSwapTransaction = async () => {
        throw failure;
      };

      expect(await run(s).catch((e: unknown) => e)).toBe(failure);
    });
  });
});

describe("SwapManager sponsor cost recovery validation", () => {
  const baseOrder = {
    mode: "ExactIn",
    inputMint: "TokenMint",
    outputMint: SOL,
    inAmount: "1000",
    outAmount: OUT_AMOUNT,
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 100,
    routePlan: [],
    feeMint: SOL,
    signatureFeeLamports: 5000,
  };

  const check = (order: Record<string, unknown> | undefined, applied: number | undefined) => {
    const { manager } = createManager();
    return () => manager.requireSponsorCostRecovery(order, applied);
  };

  test("requires an order that outputs SOL", () => {
    expect(check(undefined, 200)).toThrow("Admin-sponsored Jupiter swaps must output SOL.");
    expect(check({ ...baseOrder, outputMint: "TokenMint" }, 200)).toThrow(
      "Admin-sponsored Jupiter swaps must output SOL.",
    );
  });

  test("requires the fee to be collected in SOL", () => {
    expect(check({ ...baseOrder, feeMint: undefined }, 200)).toThrow(
      "Admin-sponsored Jupiter fees must be collected in SOL.",
    );
    expect(check({ ...baseOrder, feeMint: "TokenMint" }, 200)).toThrow(
      "Admin-sponsored Jupiter fees must be collected in SOL.",
    );
  });

  test("rejects unreliable or zero cost estimates", () => {
    expect(check({ ...baseOrder, signatureFeeLamports: undefined }, 200)).toThrow(
      "Jupiter did not provide reliable sponsor cost estimates.",
    );
    expect(check({ ...baseOrder, rentFeeLamports: -1 }, 200)).toThrow(
      "Jupiter did not provide reliable sponsor cost estimates.",
    );
    expect(check({ ...baseOrder, signatureFeeLamports: 0 }, 200)).toThrow(
      "Jupiter did not provide a positive sponsor cost estimate.",
    );
  });

  test("rejects invalid output amounts", () => {
    expect(check({ ...baseOrder, outAmount: "not-a-number" }, 200)).toThrow(
      "Jupiter returned an invalid sponsored swap output amount.",
    );
    expect(check({ ...baseOrder, outAmount: "0" }, 200)).toThrow(
      "Jupiter returned an invalid sponsored swap output amount.",
    );
  });

  test("rejects trades too small for the maximum referral fee", () => {
    expect(check({ ...baseOrder, outAmount: "1000" }, 255)).toThrow(
      "Trade is too small to recover the Jupiter sponsor cost.",
    );
  });

  test("reports a missing applied fee", () => {
    expect(check(baseOrder, undefined)).toThrow("with the confirmed missing bps fee");
    expect(check(baseOrder, 105)).not.toThrow();
  });
});

describe("SwapManager.executeJupiterTransaction guards", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("refuses to sign when the fee payer is not the expected operator", async () => {
    const { manager } = createManager();
    const user = await Keypair.generate();
    const operator = await Keypair.generate();
    manager.jupiterClient.executeOrder = async () => {
      throw new Error("must not execute");
    };

    await expect(
      manager.executeJupiterTransaction(
        serializeTx(user),
        "req",
        [user],
        operator.publicKey.toBase58(),
      ),
    ).rejects.toThrow(
      `Failed to execute Jupiter transaction: Jupiter transaction fee payer ${user.publicKey.toBase58()} does not match the required operator payer ${operator.publicKey.toBase58()}.`,
    );
  });

  test("reports the raw status when Jupiter gives no error text", async () => {
    const { manager } = createManager();
    const user = await Keypair.generate();
    manager.jupiterClient.executeOrder = async () => ({ status: "Pending" });

    await expect(
      manager.executeJupiterTransaction(serializeTx(user), "req", [user]),
    ).rejects.toThrow("Jupiter execute returned status Pending");
  });

  test("tryParsePublicKey returns null for empty and malformed keys", async () => {
    const { manager } = createManager();
    const key = (await Keypair.generate()).publicKey;

    expect(manager.tryParsePublicKey(undefined)).toBeNull();
    expect(manager.tryParsePublicKey("")).toBeNull();
    expect(manager.tryParsePublicKey("nope")).toBeNull();
    expect(manager.tryParsePublicKey(key.toBase58()).equals(key)).toBe(true);
  });
});
