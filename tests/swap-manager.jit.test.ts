import { describe, test, expect, beforeEach } from "bun:test";
import { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";

import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import { MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS } from "../src/utils/constants";

describe("SwapManager.performJustInTimeSolSwap", () => {
  const mnemonic = "test walk nut penalty hip pave soap entry language right filter choice";
  const connection = new Connection("http://localhost:8899", "confirmed");

  beforeEach(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  });

  test("returns without swapping when SOL balance already sufficient", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const swapManager = new SwapManager(connection, wallet);
    (swapManager as any).connection = {
      getBalance: async () => MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
    };

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 1_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(false);
  });

  test("returns helpful error when Jupiter requires more tokens than available", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    (wallet as any).sendTransaction = async () => "sponsored";
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet);
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "jupiter";
    (swapManager as any).jupiterClient.getQuote = async () => ({
      inAmount: "2000000",
      inputMint: "",
      outputMint: "",
      outAmount: "0",
      otherAmountThreshold: "0",
      swapMode: "ExactOut",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      contextSlot: 0,
      timeTaken: 0,
    });

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 1_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(false);
    expect(result.error).toMatch(/Need/);
  });

  test("executes pump.fun swap with admin as fee payer", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    const sendCalls: Keypair[][] = [];
    (wallet as any).sendTransaction = async (
      _ixs: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push(signers);
      return "SIG_PUMP";
    };
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet);
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "pump-fun";
    (swapManager as any).pumpFunClient.getQuote = async () => ({
      outputAmount: "4000000",
    });
    (swapManager as any).pumpFunClient.createSwapTransaction = async () => [
      {} as TransactionInstruction,
    ];

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 10_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(true);
    expect(result.provider).toBe("pump-fun");
    expect(result.signature).toBe("SIG_PUMP");
    expect(sendCalls[0]?.[0]?.publicKey.equals(admin.publicKey)).toBe(true);
    expect(sendCalls[0]?.[1]?.publicKey.equals(user.publicKey)).toBe(true);
  });
});
