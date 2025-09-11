import { describe, test, expect } from "bun:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

class ConnParsed implements Partial<Connection> {
  async getParsedTokenAccountsByOwner(_owner: PublicKey, filter: any) {
    const program = filter?.programId?.toBase58?.() || "";
    // SPL Token program mints USDC
    if (program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
      return {
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: { amount: "1000", decimals: 6 },
                    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                  },
                },
              },
            },
          },
        ],
      } as any;
    }
    // Token-2022 program mints WSOL (for test simplicity)
    if (program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
      return {
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: { amount: "500000000", decimals: 9 },
                    mint: "So11111111111111111111111111111111111111112",
                  },
                },
              },
            },
          },
        ],
      } as any;
    }
    return { value: [] } as any;
  }
}

describe("WalletManager.getAllApprovedTokenBalances", () => {
  test("returns filtered balances for approved tokens", async () => {
    const wm = WalletManager.createForTest(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      { connection: new ConnParsed() as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );

    const approved = [
      { token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", token_ticker: "USDC", decimals: 6 },
      { token_mint: "So11111111111111111111111111111111111111112", token_ticker: "WSOL", decimals: 9 },
    ];

    const res = await wm.getAllApprovedTokenBalances(1n, approved);
    expect(res.length).toBe(2);
    const usdc = res.find((r) => r.ticker === "USDC")!;
    const wsol = res.find((r) => r.ticker === "WSOL")!;
    expect(usdc.balance).toBe(1000);
    expect(wsol.balance).toBe(500000000);
  });
});
