import { Buffer } from "buffer";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.executeJupiterSwap", () => {
  let origNet: string | undefined;
  beforeEach(() => { origNet = process.env.SOLANA_NETWORK; process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; });
  afterEach(() => { process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!; });

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

  test("executes serialized Jupiter transaction and returns signature", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    // Avoid network and account creation
    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    // Stub Jupiter swap endpoint response
    Reflect.get(sm, "jupiterClient").getSwapTransaction = async () => ({
      swapTransaction: base64Tx,
      requestId: "req-123",
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
  });

  test("executes fallback Jupiter transaction without admin signer", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    Object.assign(connection, { getBalance: async () => 1_000_000_000 });
    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getAdminKeypair", () => {
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
      },
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: "admin",
        closeAuthority: "admin",
        payerKind: "admin" as const,
      },
    };

    const sig = await sm.executeJupiterSwap(req, quote);
    expect(sig).toBe("SIG_FALLBACK");
    expect(capturedExecuteRequest.requestId).toBe("req-fallback");
  });

  test("blocks user-paid fallback when user lacks SOL for route costs", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    Object.assign(connection, { getBalance: async () => 0 });
    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
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
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: "admin",
        closeAuthority: "admin",
        payerKind: "admin" as const,
      },
    };

    await expect(sm.executeJupiterSwap(req, quote)).rejects.toThrow(
      /user-paid SOL fees/
    );
    expect(executeCalled).toBe(false);
  });

  test("falls back to build with admin payer and atomic reimbursement for zero-SOL token to SOL swaps", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const admin = Keypair.generate();
    const swapProgram = Keypair.generate().publicKey;
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
      },
      integrator: {
        referralAccount: "referral",
        referralFee: 85,
        payer: admin.publicKey.toBase58(),
        closeAuthority: admin.publicKey.toBase58(),
        payerKind: "admin" as const,
      },
    };

    Reflect.set(sm, "createTokenAccountsIfNeeded", async () => []);
    Reflect.set(wallet, "getAdminKeypair", () => admin);
    Object.assign(connection, {
      getBalance: async (address: PublicKey) =>
        address.equals(user.publicKey) ? 0 : 10_000_000,
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 123,
      }),
      simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 200_000 } }),
      sendTransaction: async (tx: VersionedTransaction) => {
        capturedTx = tx;
        return "SIG_BUILD_FALLBACK";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
      getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", confirmations: 1, err: null }] }),
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
          programId: swapProgram,
          keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.from([1, 2, 3]),
        })
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

    let capturedTx: VersionedTransaction | null = null;
    const sig = await sm.executeJupiterSwap(
      {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        amount: quote.inputAmountRaw,
        userKeypair: user,
        inputDecimals: 6,
        outputDecimals: 9,
        inputTicker: "TIMBA",
        outputTicker: "SOL",
      },
      quote
    );

    expect(sig).toBe("SIG_BUILD_FALLBACK");
    expect(executeCalled).toBe(false);
    expect(capturedTx).not.toBeNull();
    const message = capturedTx!.message;
    expect(message.staticAccountKeys[0]!.toBase58()).toBe(admin.publicKey.toBase58());
    expect(capturedTx!.signatures[0]!.some((byte) => byte !== 0)).toBe(true);
    expect(capturedTx!.signatures[1]!.some((byte) => byte !== 0)).toBe(true);
    const compiledPrograms = message.compiledInstructions.map(
      (ix) => message.staticAccountKeys[ix.programIdIndex]!.toBase58()
    );
    expect(compiledPrograms).toContain(swapProgram.toBase58());
    expect(compiledPrograms.at(-1)).toBe(SystemProgram.programId.toBase58());
  });
});
