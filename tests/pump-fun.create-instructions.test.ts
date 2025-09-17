import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PumpFunClient } from "../src/utils/pump-fun";
import { Keypair } from "@solana/web3.js";

class FakeConn {}

describe("PumpFunClient.createSwapTransaction", () => {
  let origNet: string | undefined;
  beforeEach(() => { origNet = process.env.SOLANA_NETWORK; process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; });
  afterEach(() => { process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!; });

  test("throws when no SOL leg present", async () => {
    const pfc = new PumpFunClient(new FakeConn() as any);
    await expect(pfc.createSwapTransaction({
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      amount: "1000",
      userKeypair: Keypair.generate(),
    } as any)).rejects.toThrow(/must involve SOL/i);
  });

  test("returns instructions for buy (SOL -> PUMP)", async () => {
    const pfc = new PumpFunClient(new FakeConn() as any);
    // Confirm pump.fun token and non-graduated
    (pfc as any).isPumpFunToken = async () => ({ isPumpFun: true, isGraduated: false });
    // SDK returns placeholder arrays
    (pfc as any).onlineSdk = {
      fetchGlobal: async () => ({}),
      fetchBuyState: async () => ({
        bondingCurve: {
          virtualSolReserves: { toString: () => "1" },
          virtualTokenReserves: { toString: () => "1" },
        },
        bondingCurveAccountInfo: {},
        associatedUserAccountInfo: null,
      }),
      fetchBondingCurve: async () => ({
        virtualSolReserves: { toString: () => "1" },
        virtualTokenReserves: { toString: () => "1" },
      }),
    };
    (pfc as any).sdk = {
      buyInstructions: async () => [],
    };
    const ix = await pfc.createSwapTransaction({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: Keypair.generate().publicKey.toBase58(),
      amount: "1000000",
      userKeypair: Keypair.generate(),
    } as any);
    expect(Array.isArray(ix)).toBe(true);
  });

  test("returns instructions for sell (PUMP -> SOL)", async () => {
    const pfc = new PumpFunClient(new FakeConn() as any);
    (pfc as any).isPumpFunToken = async () => ({ isPumpFun: true, isGraduated: false });
    (pfc as any).onlineSdk = {
      fetchGlobal: async () => ({}),
      fetchSellState: async (_mint: any, _user: any) => ({
        bondingCurveAccountInfo: {},
        bondingCurve: {
          virtualSolReserves: { toString: () => "1" },
          virtualTokenReserves: { toString: () => "1" },
        },
      }),
      fetchBondingCurve: async () => ({
        virtualSolReserves: { toString: () => "1" },
        virtualTokenReserves: { toString: () => "1" },
      }),
    };
    (pfc as any).sdk = {
      sellInstructions: async () => [],
    };
    const ix = await pfc.createSwapTransaction({
      inputMint: Keypair.generate().publicKey.toBase58(),
      outputMint: "So11111111111111111111111111111111111111112",
      amount: "1000",
      userKeypair: Keypair.generate(),
    } as any);
    expect(Array.isArray(ix)).toBe(true);
  });
});
