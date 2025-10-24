import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PumpFunClient } from "../src/utils/pump-fun";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

class FakeConn {}

describe("PumpFunClient quotes (SDK stubbed)", () => {
  let orig: string | undefined;
  beforeEach(() => { orig = process.env.SOLANA_NETWORK; process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; });
  afterEach(() => { process.env.SOLANA_NETWORK = orig || process.env.SOLANA_NETWORK!; });
  test("buy path: SOL -> PUMP calculates token amount from curve", async () => {
    const pfc = new PumpFunClient(new FakeConn() as any);
    // Force pump.fun detection and provide simple bonding curve
    (pfc as any).isPumpFunToken = async () => ({ isPumpFun: true, isGraduated: false });
    (pfc as any).onlineSdk = {
      fetchGlobal: async () => ({
        feeBasisPoints: new BN(0),
        creatorFeeBasisPoints: new BN(0),
      }),
      fetchBondingCurve: async () => ({
        virtualSolReserves: { toString: () => String(1_000_000_000_000) },
        virtualTokenReserves: { toString: () => String(1_000_000_000) },
        creator: PublicKey.default,
      }),
    };

    const pumpMint = Keypair.generate().publicKey.toBase58();
    const res = await pfc.getQuote(
      "So11111111111111111111111111111111111111112",
      pumpMint,
      "0.001",
      9,
      6,
      100
    );

    expect(res.inputMint).toContain("11112");
    expect(Number(res.outputAmount)).toBe(1000);
    expect(res.isGraduated).toBe(false);
  });

  test("sell path: PUMP -> SOL calculates lamports from curve", async () => {
    const pfc = new PumpFunClient(new FakeConn() as any);
    (pfc as any).isPumpFunToken = async () => ({ isPumpFun: true, isGraduated: false });
    (pfc as any).onlineSdk = {
      fetchGlobal: async () => ({
        feeBasisPoints: new BN(0),
        creatorFeeBasisPoints: new BN(0),
      }),
      fetchBondingCurve: async () => ({
        virtualSolReserves: { toString: () => String(1_000_000_000_000) },
        virtualTokenReserves: { toString: () => String(1_000_000_000) },
        creator: PublicKey.default,
      }),
    };

    const pumpMint = Keypair.generate().publicKey.toBase58();
    const res = await pfc.getQuote(
      pumpMint,
      "So11111111111111111111111111111111111111112",
      "0.002",
      6,
      9,
      100
    );

    expect(Number(res.outputAmount)).toBe(1_999_996);
  });

  test("sell min-out matches constant product math for large trades", async () => {
    const pfc = new PumpFunClient(new FakeConn() as any);
    const pumpMint = Keypair.generate();
    const userKeypair = Keypair.generate();
    (pfc as any).isPumpFunToken = async () => ({
      isPumpFun: true,
      isGraduated: false,
    });
    (pfc as any).getMintDecimals = async () => 6;

    const calls: any[] = [];

    (pfc as any).onlineSdk = {
      fetchGlobal: async () => ({
        feeBasisPoints: new BN(200),
        creatorFeeBasisPoints: new BN(0),
      }),
      fetchSellState: async () => ({
        bondingCurveAccountInfo: {},
        bondingCurve: {
          virtualSolReserves: { toString: () => String(2_000_000_000_000) },
          virtualTokenReserves: { toString: () => String(1_000_000_000_000) },
          creator: PublicKey.default,
        },
      }),
      fetchBondingCurve: async () => ({
        virtualSolReserves: { toString: () => String(2_000_000_000_000) },
        virtualTokenReserves: { toString: () => String(1_000_000_000_000) },
        creator: PublicKey.default,
      }),
    };
    (pfc as any).sdk = {
      sellInstructions: async (args: any) => {
        calls.push(args);
        return [];
      },
    };

    await pfc.createSwapTransaction({
      inputMint: pumpMint.publicKey.toBase58(),
      outputMint: "So11111111111111111111111111111111111111112",
      amount: "400000",
      slippageBps: 100,
      userKeypair,
    });

    expect(calls).toHaveLength(1);
    const minOut = calls[0].solAmount as InstanceType<typeof BN>;

    const virtualSol = 2_000_000_000_000n;
    const virtualToken = 1_000_000_000_000n;
    const tokenIn = 400_000_000_000n;
    const rawSolOut = (tokenIn * virtualSol) / (virtualToken + tokenIn);
    const feeBps = 200n;
    const fee = (rawSolOut * feeBps + 9_999n) / 10_000n;
    const netSol = rawSolOut - fee;
    const expectedMin = (netSol * 9_900n) / 10_000n;

    expect(minOut.toString()).toBe(expectedMin.toString());
  });
});
