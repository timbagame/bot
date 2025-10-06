import { describe, test, expect } from "bun:test";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  AccountLayout,
  AccountState,
} from "@solana/spl-token";
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

  test("getTokenBalance resolves Token-2022 associated account", async () => {
    const mint = new PublicKey("8VpFGHPYK5SZqdz4Nv2qcg95Nq35p6x1Hzkwmo7aX8Qk");
    const balances: Record<string, Buffer> = {};
    let expectedAta: string | null = null;

    const connection: Partial<Connection> = {
      async getAccountInfo(pubkey: PublicKey) {
        const address = pubkey.toBase58();
        if (address === mint.toBase58()) {
          return {
            owner: TOKEN_2022_PROGRAM_ID,
            data: Buffer.alloc(0),
            executable: false,
            lamports: 0,
          } as any;
        }
        if (expectedAta && address === expectedAta) {
          return {
            owner: TOKEN_2022_PROGRAM_ID,
            data: balances[address],
            executable: false,
            lamports: 0,
          } as any;
        }
        throw new Error(`unexpected account lookup ${address}`);
      },
    };

    const wm = WalletManager.createForTest(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      { connection: connection as Connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );

    const owner = wm.getPublicKey(1n);
    expectedAta = (
      await getAssociatedTokenAddress(mint, owner, false, TOKEN_2022_PROGRAM_ID)
    ).toBase58();

    const rawAmount = 1_234_567n;
    const accountData = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint,
        owner,
        amount: rawAmount,
        delegateOption: 0,
        delegate: owner,
        state: AccountState.Initialized,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: owner,
      } as any,
      accountData
    );
    balances[expectedAta] = accountData;

    const value = await wm.getTokenBalance(1n, mint.toBase58());
    expect(value).toBe(Number(rawAmount));
  });
});
