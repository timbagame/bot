import { Buffer } from "buffer";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage } from "#solana";
import { AccountLayout, AccountState, TOKEN_PROGRAM_ID } from "#token";
import { JupiterReferralUnavailableError } from "../src/utils/jupiter";
import { __test_resetReferralConfig, __test_setReferralConfig } from "../src/utils/token-registry";
import { SOL, createManager, jupiterQuote } from "./helpers/swap-manager-fixtures";

const apiInstruction = (programId: PublicKey, account: PublicKey) => ({
  programId: programId.toBase58(),
  accounts: [{ pubkey: account.toBase58(), isSigner: true, isWritable: true }],
  data: Buffer.from([1, 2, 3]).toString("base64"),
});

const makeBuild = async (user: Keypair, overrides: Record<string, unknown> = {}) => ({
  inputMint: "TokenMint",
  outputMint: SOL,
  inAmount: "1000000",
  outAmount: "10000000",
  otherAmountThreshold: "0",
  swapMode: "ExactIn",
  slippageBps: 100,
  routePlan: [],
  computeBudgetInstructions: [],
  setupInstructions: [],
  swapInstruction: apiInstruction((await Keypair.generate()).publicKey, user.publicKey),
  cleanupInstruction: null,
  otherInstructions: [],
  tipInstruction: null,
  addressesByLookupTableAddress: null,
  blockhashWithMetadata: { blockhash: Array.from(Buffer.alloc(32)), lastValidBlockHeight: 123 },
  ...overrides,
});

const tokenAccountInfo = (mint: PublicKey, owner: PublicKey) => {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 0n,
      delegateOption: 0,
      delegate: owner,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: owner,
    } as any,
    data,
  );
  return { data, executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, rentEpoch: 0 };
};

const logSpies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(() => {
  logSpies.push(spyOn(console, "log").mockImplementation(() => {}));
  logSpies.push(spyOn(console, "error").mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of logSpies.splice(0)) {
    spy.mockRestore();
  }
  __test_resetReferralConfig();
});

describe("SwapManager build fee account validation", () => {
  test("rejects a missing account and caches nothing", async () => {
    const feeAccount = (await Keypair.generate()).publicKey;
    const referral = (await Keypair.generate()).publicKey;
    const { manager } = createManager({ connection: { getAccountInfo: async () => null } });

    await expect(manager.validateBuildFeeAccount(feeAccount, referral)).rejects.toThrow(
      `Jupiter build fee account ${feeAccount.toBase58()} does not exist.`,
    );
    expect(manager.validatedBuildFeeAccounts.size).toBe(0);
  });

  test("rejects data that is not an SPL token account", async () => {
    const feeAccount = (await Keypair.generate()).publicKey;
    const referral = (await Keypair.generate()).publicKey;
    const { manager } = createManager({
      connection: {
        getAccountInfo: async () => ({
          data: Buffer.alloc(10),
          executable: false,
          lamports: 1,
          owner: TOKEN_PROGRAM_ID,
          rentEpoch: 0,
        }),
      },
    });

    const error = await manager
      .validateBuildFeeAccount(feeAccount, referral)
      .catch((e: unknown) => e as Error);

    expect(error.message).toBe(
      `Jupiter build fee account ${feeAccount.toBase58()} is not a valid SPL token account.`,
    );
    expect(error.cause).toBeDefined();
  });

  test("rejects token accounts that are not WSOL", async () => {
    const feeAccount = (await Keypair.generate()).publicKey;
    const referral = (await Keypair.generate()).publicKey;
    const otherMint = (await Keypair.generate()).publicKey;
    const { manager } = createManager({
      connection: { getAccountInfo: async () => tokenAccountInfo(otherMint, referral) },
    });

    await expect(manager.validateBuildFeeAccount(feeAccount, referral)).rejects.toThrow(
      "Jupiter build fee account must be a WSOL token account.",
    );
  });

  test("skips the RPC lookup once an account has been validated", async () => {
    const feeAccount = (await Keypair.generate()).publicKey;
    const referral = (await Keypair.generate()).publicKey;
    let lookups = 0;
    const { manager } = createManager({
      connection: {
        getAccountInfo: async () => {
          lookups += 1;
          return tokenAccountInfo(new PublicKey(SOL), referral);
        },
      },
    });

    await manager.validateBuildFeeAccount(feeAccount, referral);
    await manager.validateBuildFeeAccount(feeAccount, referral);

    expect(lookups).toBe(1);
  });
});

describe("SwapManager.prepareAtomicBuildFallback failures", () => {
  const prepare = async (
    options: {
      operatorIsPayer?: boolean;
      build?: Record<string, unknown>;
      connection?: Record<string, unknown>;
      configure?: () => void;
    } = {},
  ) => {
    const user = await Keypair.generate();
    const admin = await Keypair.generate();
    const { manager } = createManager({
      operator: admin,
      connection: {
        simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 100_000 } }),
        getFeeForMessage: async () => ({ value: 5_000 }),
        getBalance: async () => 100_000_000,
        ...options.connection,
      },
    });
    manager.validateBuildFeeAccount = async () => {};
    const build = await makeBuild(user, options.build);
    manager.jupiterClient.getBuildInstructions = async () => build;
    options.configure?.();
    const payer =
      options.operatorIsPayer === false
        ? (await Keypair.generate()).publicKey.toBase58()
        : admin.publicKey.toBase58();
    const quote: any = {
      inputMint: "TokenMint",
      outputMint: SOL,
      inputAmountRaw: "1000000",
      providerQuote: { slippageBps: 100 },
      integrator: {
        referralAccount: "referral",
        referralFee: 100,
        payer,
        closeAuthority: payer,
        payerKind: "admin",
      },
    };
    const call = () =>
      manager.prepareAtomicBuildFallback({
        request: { userKeypair: user },
        quote,
        jupiterQuote: jupiterQuote({ outputMint: SOL, swapMode: "ExactOut" }),
        operatorKeypair: admin,
      });
    return { call, build, admin, user };
  };

  test("rejects an integrator payer that is not the operator", async () => {
    const { call, admin } = await prepare({ operatorIsPayer: false });

    await expect(call()).rejects.toThrow(
      `Integrator operator payer does not match loaded operator keypair ${admin.publicKey.toBase58()}`,
    );
  });

  test("requires a configured build fee account", async () => {
    const { call } = await prepare({
      configure: () =>
        __test_setReferralConfig({
          referralAccount: "GPBNTRmo26MRoaLSvRXwhWaQZhYjwVWgEkgwRZVU6x9U",
        }),
    });

    await expect(call()).rejects.toThrow("Jupiter build fee account is not configured.");
  });

  test("refuses builds that include an unreimbursed tip instruction", async () => {
    const user = await Keypair.generate();
    const { call } = await prepare({
      build: { tipInstruction: apiInstruction(SystemProgram.programId, user.publicKey) },
    });

    await expect(call()).rejects.toThrow(
      "Jupiter build returned an unreimbursed tip instruction; refusing execution.",
    );
  });

  test("falls back to the maximum compute limit when the simulation reports no units", async () => {
    const { call } = await prepare({
      connection: { simulateTransaction: async () => ({ value: { err: null } }) },
    });

    const prepared = await call();

    expect(prepared.computeUnitLimit).toBe(1_400_000);
    expect(prepared.reimbursementLamports).toBe(5_000);
    expect(prepared.grossOutputAmount).toBe("10000000");
    expect(prepared.netOutputAmount).toBe("9995000");
  });

  test("fails when the network fee cannot be estimated", async () => {
    const { call } = await prepare({
      connection: { getFeeForMessage: async () => ({ value: null }) },
    });

    await expect(call()).rejects.toThrow("Unable to estimate the Jupiter build transaction fee.");
  });

  test("fails when the reimbursement would be zero", async () => {
    const { call } = await prepare({
      connection: { getFeeForMessage: async () => ({ value: 0 }) },
    });

    await expect(call()).rejects.toThrow(
      "Jupiter build reimbursement must be a positive safe integer.",
    );
  });

  test("fails when the build output amount is not numeric", async () => {
    const { call } = await prepare({ build: { outAmount: "lots" } });

    await expect(call()).rejects.toThrow("Jupiter build returned an invalid output amount.");
  });
});

describe("SwapManager.executeAtomicBuildFallback guards", () => {
  const prepared = (build: unknown) => ({
    build,
    computeUnitLimit: 200_000,
    reimbursementLamports: 5_000,
    grossOutputAmount: "10000000",
    netOutputAmount: "9995000",
  });

  test("rejects an integrator payer that is not the operator", async () => {
    const { manager } = createManager();
    const operator = await Keypair.generate();
    const other = (await Keypair.generate()).publicKey.toBase58();

    await expect(
      manager.executeAtomicBuildFallback({
        request: { userKeypair: await Keypair.generate() },
        quote: { integrator: { payer: other } },
        operatorKeypair: operator,
        preparedBuild: prepared({}),
      }),
    ).rejects.toThrow(
      `Integrator operator payer does not match loaded operator keypair ${operator.publicKey.toBase58()}`,
    );
  });

  test("rejects a prepared message whose fee payer is not the operator", async () => {
    const { manager } = createManager();
    const operator = await Keypair.generate();
    const intruder = await Keypair.generate();
    manager.buildPreparedJupiterMessage = () =>
      new TransactionMessage({
        payerKey: intruder.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [],
      }).compileToV0Message();
    manager.connection.sendTransaction = async () => {
      throw new Error("must not send");
    };

    await expect(
      manager.executeAtomicBuildFallback({
        request: { userKeypair: await Keypair.generate() },
        quote: { integrator: { payer: operator.publicKey.toBase58() } },
        operatorKeypair: operator,
        preparedBuild: prepared({}),
      }),
    ).rejects.toThrow("Prepared Jupiter build does not use the operator as fee payer.");
  });
});

describe("SwapManager.ensureAdminCanCoverRoute", () => {
  test("does nothing for user-paid integrators or when there is no order", async () => {
    const { manager } = createManager({
      connection: {
        getBalance: async () => {
          throw new Error("must not query the balance");
        },
      },
    });
    const key = (await Keypair.generate()).publicKey;
    const integrator = { payerKind: "user" } as any;

    expect(await manager.ensureAdminCanCoverRoute(integrator, {}, key)).toBeUndefined();
    expect(await manager.ensureAdminCanCoverRoute({ payerKind: "admin" }, undefined, key)).toBe(
      undefined,
    );
    expect(await manager.ensureAdminCanCoverRoute(null, {}, key)).toBeUndefined();
  });
});

describe("SwapManager quote routing", () => {
  const request = async (overrides: Record<string, unknown> = {}) => ({
    inputMint: (await Keypair.generate()).publicKey.toBase58(),
    outputMint: SOL,
    amount: "1000000",
    userKeypair: await Keypair.generate(),
    inputDecimals: 6,
    outputDecimals: 9,
    inputTicker: "TKN",
    outputTicker: "SOL",
    ...overrides,
  });

  test("falls back to a plain quote when the referral route is unavailable", async () => {
    const { manager } = createManager();
    const calls: any[] = [];
    manager.getJupiterQuote = async (params: any) => {
      calls.push(params);
      if (params.referralAccount) {
        throw new JupiterReferralUnavailableError("referral account unavailable");
      }
      return jupiterQuote({ outputMint: SOL });
    };

    const result = await manager.getJupiterQuoteForRoute(
      {
        inputMint: "TokenMint",
        outputMint: SOL,
        amount: "1000000",
        taker: "taker",
        swapMode: "ExactIn",
        slippageBps: 75,
        referralAccount: "ref",
        referralFee: 120,
        payer: "payer",
        closeAuthority: "close",
        outputDecimals: 9,
      },
      true,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      inputMint: "TokenMint",
      outputMint: SOL,
      amount: "1000000",
      taker: "taker",
      swapMode: "ExactIn",
      slippageBps: 75,
    });
    expect(result).toMatchObject({
      referralApplied: false,
      payerApplied: false,
      integratorFallback: true,
      integratorFallbackReason: "referral account unavailable",
    });
  });

  test("rethrows when the build fallback is not allowed or the error is unrelated", async () => {
    const { manager } = createManager();
    const unavailable = new JupiterReferralUnavailableError("gone");
    manager.getJupiterQuote = async () => {
      throw unavailable;
    };
    expect(
      await manager
        .getJupiterQuoteForRoute({ inputMint: "a", outputMint: "b", amount: "1" }, false)
        .catch((e: unknown) => e),
    ).toBe(unavailable);

    const other = new Error("boom");
    manager.getJupiterQuote = async () => {
      throw other;
    };
    expect(
      await manager
        .getJupiterQuoteForRoute({ inputMint: "a", outputMint: "b", amount: "1" }, true)
        .catch((e: unknown) => e),
    ).toBe(other);
  });

  test("refuses to quote a token against itself", async () => {
    const { manager } = createManager();
    const mint = (await Keypair.generate()).publicKey.toBase58();
    manager.getJupiterQuote = async () => {
      throw new Error("must not reach Jupiter");
    };

    await expect(
      manager.getQuote(await request({ inputMint: mint, outputMint: mint })),
    ).rejects.toThrow("Cannot swap the same token");
  });

  test("rejects an integrator fallback quote that cannot use the atomic build route", async () => {
    const { manager } = createManager();
    manager.getJupiterQuote = async () => jupiterQuote({ integratorFallback: true });
    manager.prepareAtomicBuildFallback = async () => {
      throw new Error("must not prepare");
    };

    await expect(manager.getQuote(await request())).rejects.toThrow(
      "Jupiter could not prepare the required sponsored route.",
    );
  });
});

describe("SwapManager.formatQuoteForDisplay", () => {
  test("uses zero slippage when the quote slippage is not a finite number", () => {
    const { manager } = createManager();
    const captured: any[] = [];
    manager.jupiterClient.formatQuoteForDisplay = (arg: any) => {
      captured.push(arg);
      return "formatted";
    };

    const result = manager.formatQuoteForDisplay(
      {
        inputMint: "a",
        outputMint: "b",
        inputAmount: "1",
        outputAmount: "2",
        slippage: Number.NaN,
      },
      6,
      9,
      "A",
      "B",
    );

    expect(result).toBe("formatted");
    expect(captured[0].slippageBps).toBe(0);
  });
});
