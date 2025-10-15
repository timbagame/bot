import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PumpFunClient } from "../src/utils/pump-fun";
import { Keypair } from "@solana/web3.js";

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
      fetchBondingCurve: async () => ({
        virtualSolReserves: { toString: () => String(1_000_000_000_000) },
        virtualTokenReserves: { toString: () => String(1_000_000_000) },
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
      fetchBondingCurve: async () => ({
        virtualSolReserves: { toString: () => String(1_000_000_000_000) },
        virtualTokenReserves: { toString: () => String(1_000_000_000) },
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

    expect(Number(res.outputAmount)).toBe(2_000_000);
  });
});
