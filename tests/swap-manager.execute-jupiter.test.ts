import { Buffer } from "buffer";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "#solana";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.executeJupiterSwap", () => {
  let origNet: string | undefined;
  beforeEach(() => {
    origNet = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  });
  afterEach(() => {
    process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!;
  });

  const buildBase64Tx = (payer: Keypair): string => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    return Buffer.from(tx.serialize()).toString("base64");
  };

  const apiInstruction = (instruction: TransactionInstruction) => ({
    programId: instruction.programId.toBase58(),
    accounts: instruction.keys.map((key) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data).toString("base64"),
  });

  test("prepares build fallback costs before showing the quote", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);
    const user = await Keypair.generate();
    const admin = await Keypair.generate();
    const inputMint = (await Keypair.generate()).publicKey.toBase58();
    const fallbackQuote = {
      inputMint,
      outputMint: "So11111111111111111111111111111111111111112",
      inAmount: "1000000",
      outAmount: "750000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      integratorFallback: true,
    };
    const preparedBuild = {
      build: {} as any,
      computeUnitLimit: 200_000,
      reimbursementLamports: 5_000,
      grossOutputAmount: "740000",
      netOutputAmount: "735000",
    };

    Reflect.set(wallet, "getOperatorKeypair", () => admin);
    Reflect.set(sm, "getJupiterQuoteForRoute", async () => fallbackQuote);
    Reflect.set(sm, "prepareAtomicBuildFallback", async () => preparedBuild);

    const quote = await sm.getQuote({
      inputMint,
      outputMint: fallbackQuote.outputMint,
      amount: fallbackQuote.inAmount,
      userKeypair: user,
      inputDecimals: 6,
      outputDecimals: 9,
      inputTicker: "TIMBA",
      outputTicker: "SOL",
      integrator: {
        referralAccount: (await Keypair.generate()).publicKey.toBase58(),
        referralFee: 100,
        payer: admin.publicKey.toBase58(),
        closeAuthority: admin.publicKey.toBase58(),
        payerKind: "admin",
      },
    });

    expect(quote.outputAmount).toBe("735000");
    expect(quote.providerQuote?.outAmount).toBe("740000");
    expect(quote.executionSponsorReimbursementLamports).toBe(5_000);
    expect(quote.preparedBuild).toBe(preparedBuild);
  });

  test("executes serialized Jupiter transaction and returns signature", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);

    const user = await Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    // Avoid network and account creation
    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    // Stub Jupiter swap endpoint response
    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: base64Tx,
      requestId: "req-123",
      order: {
        mode: "ExactIn",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000000",
        outAmount: "99500",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        routePlan: [],
        feeMint: "So11111111111111111111111111111111111111112",
        feeBps: 100,
        platformFee: { amount: "500", feeBps: 50 },
      },
    });

    const capturedExecuteRequest = { requestId: "", signedTransaction: "" };
    Reflect.get(sm, "jupiterClient").executeOrder = async (payload: {
      requestId: string;
      signedTransaction: string;
    }) => {
      capturedExecuteRequest.requestId = payload.requestId;
      capturedExecuteRequest.signedTransaction = payload.signedTransaction;
      return { status: "Success", signature: "SIG_JUP_123" };
    };

    const req = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      userKeypair: user,
      inputDecimals: 9,
      outputDecimals: 6,
      inputTicker: "WSOL",
      outputTicker: "USDC",
    } as const;

    const quote = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      inputAmountRaw: req.amount,
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter" as const,
    };

    Reflect.get(sm, "jupiterClient").getQuote = async () => ({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inAmount: req.amount,
      outAmount: quote.outputAmount,
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
    });

    const sig = await sm.executeJupiterSwap(req, quote);
    expect(sig).toBe("SIG_JUP_123");
    expect(capturedExecuteRequest.requestId).toBe("req-123");
    expect(typeof capturedExecuteRequest.signedTransaction).toBe("string");
    expect((quote as any).executionFeeAmount).toBe("500");
    expect((quote as any).executionFeeBps).toBe(50);
    expect((quote as any).executionOutputAmount).toBe("99500");
  });

  test("rejects a fee-free fallback Jupiter transaction", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);

    const user = await Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    Object.assign(connection, { getBalance: async () => 1_000_000_000 });
    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getOperatorKeypair", () => {
      throw new Error("admin keypair should not be loaded for user-paid fallback");
    });
    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: base64Tx,
      requestId: "req-fallback",
      order: {
        requestId: "req-fallback",
        integratorFallback: true,
        integratorFallbackReason: "Failed to get quotes",
        payerApplied: false,
        referralApplied: false,
      },
    });

    const capturedExecuteRequest = { requestId: "" };
    Reflect.get(sm, "jupiterClient").executeOrder = async (payload: { requestId?: string }) => {
      capturedExecuteRequest.requestId = payload.requestId ?? "";
      return { status: "Success", signature: "SIG_FALLBACK" };
    };

    const req = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      userKeypair: user,
      inputDecimals: 9,
      outputDecimals: 6,
      inputTicker: "WSOL",
      outputTicker: "USDC",
    } as const;

    const quote = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      inputAmountRaw: req.amount,
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        inAmount: req.amount,
        outAmount: "100",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        rentFeeLamports: 0,
      },
      providerQuoteTimestamp: Date.now(),
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: "admin",
        closeAuthority: "admin",
        payerKind: "admin" as const,
      },
    };

    await expect(sm.executeJupiterSwap(req, quote)).rejects.toThrow(/required swap fee/);
    expect(capturedExecuteRequest.requestId).toBe("");
  });

  test("blocks user-paid fallback when user lacks SOL for route costs", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);

    const user = await Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    Object.assign(connection, { getBalance: async () => 0 });
    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getOperatorKeypair", () => {
      throw new Error("admin keypair should not be loaded for invalid payer fallback");
    });
    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: base64Tx,
      requestId: "req-low-sol-fallback",
      order: {
        requestId: "req-low-sol-fallback",
        integratorFallback: true,
        integratorFallbackReason: "Failed to get quotes",
        payerApplied: false,
        referralApplied: false,
        signatureFeeLamports: 5000,
      },
    });

    let executeCalled = false;
    Reflect.get(sm, "jupiterClient").executeOrder = async () => {
      executeCalled = true;
      return { status: "Success", signature: "SIG_SHOULD_NOT_RUN" };
    };

    const req = {
      inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      outputMint: "So11111111111111111111111111111111111111112",
      amount: "1000000",
      userKeypair: user,
      inputDecimals: 6,
      outputDecimals: 9,
      inputTicker: "TIMBA",
      outputTicker: "SOL",
    } as const;

    const quote = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      inputAmountRaw: req.amount,
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        inAmount: req.amount,
        outAmount: "100",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
      },
      providerQuoteTimestamp: Date.now(),
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: "admin",
        closeAuthority: "admin",
        payerKind: "admin" as const,
      },
    };

    try {
      await sm.executeJupiterSwap(req, quote);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/required swap fee/);
    }
    expect(executeCalled).toBe(false);
  });

  test("falls back to build with admin payer and atomic reimbursement for zero-SOL token to SOL swaps", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);

    const user = await Keypair.generate();
    const admin = await Keypair.generate();
    const swapProgram = (await Keypair.generate()).publicKey;
    const cleanupProgram = (await Keypair.generate()).publicKey;
    const quote = {
      inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "750000",
      estimatedRate: 0.75,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
        outputMint: "So11111111111111111111111111111111111111112",
        inAmount: "1000000",
        outAmount: "750000",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        rentFeeLamports: 0,
      },
      providerQuoteTimestamp: Date.now(),
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: admin.publicKey.toBase58(),
        closeAuthority: admin.publicKey.toBase58(),
        payerKind: "admin" as const,
      },
    };

    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getOperatorKeypair", () => admin);
    Reflect.set(sm, "validateBuildFeeAccount", async () => {});
    Object.assign(connection, {
      getBalance: async (address: PublicKey) => (address.equals(user.publicKey) ? 0 : 10_000_000),
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 123,
      }),
      simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 200_000 } }),
      getFeeForMessage: async () => ({ value: 5_000 }),
      sendTransaction: async (tx: VersionedTransaction) => {
        capturedTx = tx;
        return "SIG_BUILD_FALLBACK";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
      getSignatureStatuses: async () => ({
        value: [{ confirmationStatus: "confirmed", confirmations: 1, err: null }],
      }),
    });

    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: buildBase64Tx(user),
      requestId: "req-low-sol-fallback",
      order: {
        requestId: "req-low-sol-fallback",
        integratorFallback: true,
        integratorFallbackReason: "Failed to get quotes",
        payerApplied: false,
        referralApplied: false,
        signatureFeeLamports: 5000,
      },
    });
    let executeCalled = false;
    Reflect.get(sm, "jupiterClient").executeOrder = async () => {
      executeCalled = true;
      return { status: "Success", signature: "SIG_SHOULD_NOT_RUN" };
    };
    let capturedBuildRequest: Record<string, unknown> | null = null;
    Reflect.get(sm, "jupiterClient").getBuildInstructions = async (
      payload: Record<string, unknown>,
    ) => {
      capturedBuildRequest = payload;
      return {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.inputAmountRaw,
        outAmount: quote.outputAmount,
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        routePlan: [],
        computeBudgetInstructions: [
          apiInstruction(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 })),
          apiInstruction(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })),
        ],
        setupInstructions: [],
        swapInstruction: apiInstruction(
          new TransactionInstruction({
            programId: swapProgram,
            keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
            data: Buffer.from([1, 2, 3]),
          }),
        ),
        cleanupInstruction: apiInstruction(
          new TransactionInstruction({
            programId: cleanupProgram,
            keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
            data: Buffer.from([4, 5, 6]),
          }),
        ),
        otherInstructions: [],
        tipInstruction: null,
        addressesByLookupTableAddress: null,
        blockhashWithMetadata: {
          blockhash: Array.from(Buffer.alloc(32)),
          lastValidBlockHeight: 123,
        },
      };
    };

    const request = {
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmountRaw,
      userKeypair: user,
      inputDecimals: 6,
      outputDecimals: 9,
      inputTicker: "TIMBA",
      outputTicker: "SOL",
    };
    const preparedBuild = await (sm as any).prepareAtomicBuildFallback({
      request,
      quote,
      jupiterQuote: quote.providerQuote,
      operatorKeypair: admin,
    });
    (quote as any).preparedBuild = preparedBuild;

    let capturedTx: VersionedTransaction | null = null;
    const sig = await sm.executeJupiterSwap(request, quote);

    expect(sig).toBe("SIG_BUILD_FALLBACK");
    expect(executeCalled).toBe(false);
    expect(capturedBuildRequest).toMatchObject({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmountRaw,
      taker: user.publicKey.toBase58(),
      payer: admin.publicKey.toBase58(),
      swapMode: "ExactIn",
      slippageBps: 100,
      platformFeeBps: 100,
      feeAccount: "3Zakc3mEdWa6v4Sd5ywDJgUrcz5VK7FrdnHnV4DT1hbQ",
    });
    expect(capturedTx).not.toBeNull();
    const message = capturedTx!.message;
    expect(message.staticAccountKeys[0]!.toBase58()).toBe(admin.publicKey.toBase58());
    expect(capturedTx!.signatures[0]!.some((byte) => byte !== 0)).toBe(true);
    expect(capturedTx!.signatures[1]!.some((byte) => byte !== 0)).toBe(true);
    const compiledPrograms = message.compiledInstructions.map((ix) =>
      message.staticAccountKeys[ix.programIdIndex]!.toBase58(),
    );
    expect(compiledPrograms).toContain(swapProgram.toBase58());
    expect(compiledPrograms.indexOf(swapProgram.toBase58())).toBeLessThan(
      compiledPrograms.indexOf(cleanupProgram.toBase58()),
    );
    expect(compiledPrograms.indexOf(cleanupProgram.toBase58())).toBeLessThan(
      compiledPrograms.lastIndexOf(SystemProgram.programId.toBase58()),
    );
    expect(compiledPrograms.at(-1)).toBe(SystemProgram.programId.toBase58());
    const computeInstructions = message.compiledInstructions.filter((instruction) =>
      message.staticAccountKeys[instruction.programIdIndex]!.equals(ComputeBudgetProgram.programId),
    );
    expect(computeInstructions.filter((instruction) => instruction.data[0] === 2)).toHaveLength(1);
    expect(computeInstructions.filter((instruction) => instruction.data[0] === 3)).toHaveLength(1);
    expect((quote as any).executionReferralApplied).toBe(true);
    expect((quote as any).executionFeeMint).toBe("So11111111111111111111111111111111111111112");
    expect((quote as any).executionOutputAmount).toBe("745000");
    expect((quote as any).executionSponsorReimbursementLamports).toBe(5_000);
  });

  test("build fallback throws when simulation fails", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);

    const user = await Keypair.generate();
    const admin = await Keypair.generate();
    const quote = {
      inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "750000",
      estimatedRate: 0.75,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
        outputMint: "So11111111111111111111111111111111111111112",
        inAmount: "1000000",
        outAmount: "750000",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        rentFeeLamports: 0,
      },
      providerQuoteTimestamp: Date.now(),
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: admin.publicKey.toBase58(),
        closeAuthority: admin.publicKey.toBase58(),
        payerKind: "admin" as const,
      },
    };

    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getOperatorKeypair", () => admin);
    Reflect.set(sm, "validateBuildFeeAccount", async () => {});
    Object.assign(connection, {
      getBalance: async (address: PublicKey) => (address.equals(user.publicKey) ? 0 : 10_000_000),
      simulateTransaction: async () => ({
        value: { err: "SimulationFailed", unitsConsumed: null },
      }),
    });

    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: buildBase64Tx(user),
      requestId: "req-sim-fail",
      order: {
        requestId: "req-sim-fail",
        integratorFallback: true,
        integratorFallbackReason: "Failed to get quotes",
        payerApplied: false,
        referralApplied: false,
        signatureFeeLamports: 5000,
      },
    });
    Reflect.get(sm, "jupiterClient").getBuildInstructions = async () => ({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inputAmountRaw,
      outAmount: quote.outputAmount,
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      routePlan: [],
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: apiInstruction(
        new TransactionInstruction({
          programId: (await Keypair.generate()).publicKey,
          keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.from([1]),
        }),
      ),
      cleanupInstruction: null,
      otherInstructions: [],
      tipInstruction: null,
      addressesByLookupTableAddress: null,
      blockhashWithMetadata: {
        blockhash: Array.from(Buffer.alloc(32)),
        lastValidBlockHeight: 123,
      },
    });

    try {
      await (sm as any).prepareAtomicBuildFallback({
        request: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmountRaw,
          userKeypair: user,
          inputDecimals: 6,
          outputDecimals: 9,
          inputTicker: "TIMBA",
          outputTicker: "SOL",
        },
        quote,
        jupiterQuote: quote.providerQuote,
        operatorKeypair: admin,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/simulation failed/i);
    }
  });

  test("build fallback throws when output is too small to reimburse admin", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);

    const user = await Keypair.generate();
    const admin = await Keypair.generate();
    const quote = {
      inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "1",
      estimatedRate: 0.000001,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
        outputMint: "So11111111111111111111111111111111111111112",
        inAmount: "1000000",
        outAmount: "1",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        rentFeeLamports: 0,
      },
      providerQuoteTimestamp: Date.now(),
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: admin.publicKey.toBase58(),
        closeAuthority: admin.publicKey.toBase58(),
        payerKind: "admin" as const,
      },
    };

    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getOperatorKeypair", () => admin);
    Reflect.set(sm, "validateBuildFeeAccount", async () => {});
    Object.assign(connection, {
      getBalance: async (address: PublicKey) => (address.equals(user.publicKey) ? 0 : 10_000_000),
      simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 200_000 } }),
      getFeeForMessage: async () => ({ value: 5_000 }),
    });

    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: buildBase64Tx(user),
      requestId: "req-small-output",
      order: {
        requestId: "req-small-output",
        integratorFallback: true,
        integratorFallbackReason: "Failed to get quotes",
        payerApplied: false,
        referralApplied: false,
        signatureFeeLamports: 5000,
      },
    });
    Reflect.get(sm, "jupiterClient").getBuildInstructions = async () => ({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inputAmountRaw,
      outAmount: "1",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      routePlan: [],
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: apiInstruction(
        new TransactionInstruction({
          programId: (await Keypair.generate()).publicKey,
          keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.from([1]),
        }),
      ),
      cleanupInstruction: null,
      otherInstructions: [],
      tipInstruction: null,
      addressesByLookupTableAddress: null,
      blockhashWithMetadata: {
        blockhash: Array.from(Buffer.alloc(32)),
        lastValidBlockHeight: 123,
      },
    });

    try {
      await (sm as any).prepareAtomicBuildFallback({
        request: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmountRaw,
          userKeypair: user,
          inputDecimals: 6,
          outputDecimals: 9,
          inputTicker: "TIMBA",
          outputTicker: "SOL",
        },
        quote,
        jupiterQuote: quote.providerQuote,
        operatorKeypair: admin,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/too small to reimburse/i);
    }
  });

  test("build fallback throws when confirmed transaction has on-chain error", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);

    const user = await Keypair.generate();
    const admin = await Keypair.generate();
    const quote = {
      inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "750000",
      estimatedRate: 0.75,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
        outputMint: "So11111111111111111111111111111111111111112",
        inAmount: "1000000",
        outAmount: "750000",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        rentFeeLamports: 0,
      },
      providerQuoteTimestamp: Date.now(),
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: admin.publicKey.toBase58(),
        closeAuthority: admin.publicKey.toBase58(),
        payerKind: "admin" as const,
      },
    };

    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getOperatorKeypair", () => admin);
    Reflect.set(sm, "validateBuildFeeAccount", async () => {});
    Object.assign(connection, {
      getBalance: async (address: PublicKey) => (address.equals(user.publicKey) ? 0 : 10_000_000),
      simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 200_000 } }),
      getFeeForMessage: async () => ({ value: 5_000 }),
      sendTransaction: async () => "SIG_ERR",
      confirmTransaction: async () => ({ value: { err: "InsufficientFundsForRent" } }),
    });

    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: buildBase64Tx(user),
      requestId: "req-confirm-fail",
      order: {
        requestId: "req-confirm-fail",
        integratorFallback: true,
        integratorFallbackReason: "Failed to get quotes",
        payerApplied: false,
        referralApplied: false,
        signatureFeeLamports: 5000,
      },
    });
    Reflect.get(sm, "jupiterClient").getBuildInstructions = async () => ({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inputAmountRaw,
      outAmount: quote.outputAmount,
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      routePlan: [],
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: apiInstruction(
        new TransactionInstruction({
          programId: (await Keypair.generate()).publicKey,
          keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.from([1]),
        }),
      ),
      cleanupInstruction: null,
      otherInstructions: [],
      tipInstruction: null,
      addressesByLookupTableAddress: null,
      blockhashWithMetadata: {
        blockhash: Array.from(Buffer.alloc(32)),
        lastValidBlockHeight: 123,
      },
    });

    try {
      const request = {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        amount: quote.inputAmountRaw,
        userKeypair: user,
        inputDecimals: 6,
        outputDecimals: 9,
        inputTicker: "TIMBA",
        outputTicker: "SOL",
      };
      (quote as any).preparedBuild = await (sm as any).prepareAtomicBuildFallback({
        request,
        quote,
        jupiterQuote: quote.providerQuote,
        operatorKeypair: admin,
      });
      await sm.executeJupiterSwap(request, quote);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/confirmed with error/i);
    }
  });
});
