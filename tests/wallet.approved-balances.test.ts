import { describe, test, expect } from "bun:test";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  AccountLayout,
  AccountState,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { WalletManager } from "../src/utils/wallet";
import type { TokenDatabase } from "../src/utils/token-database";

type MockAccountEntry = {
  owner: PublicKey;
  data: Buffer;
  mint: PublicKey;
  amount: bigint;
  decimals: number;
};

class ConnParsed implements Partial<Connection> {
  public owner: PublicKey | null = null;
  public accounts = new Map<string, MockAccountEntry>();
  public parsedCalls: string[] = [];
  private mintOwners = new Map<string, PublicKey>();

  setOwner(owner: PublicKey) {
    this.owner = owner;
  }

  async seedTokenAccount(options: {
    mint: PublicKey;
    programId: PublicKey;
    amount: bigint;
    decimals: number;
  }) {
    if (!this.owner) {
      throw new Error("owner not set");
    }

    const ata = await getAssociatedTokenAddress(
      options.mint,
      this.owner,
      false,
      options.programId
    );

    const buffer = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: options.mint,
        owner: this.owner,
        amount: options.amount,
        delegateOption: 0,
        delegate: this.owner,
        state: AccountState.Initialized,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: this.owner,
      } as any,
      buffer
    );

    this.accounts.set(ata.toBase58(), {
      owner: options.programId,
      data: buffer,
      mint: options.mint,
      amount: options.amount,
      decimals: options.decimals,
    });
    this.mintOwners.set(options.mint.toBase58(), options.programId);
  }

  async getMultipleAccountsInfo(pubkeys: PublicKey[]) {
    return pubkeys.map((pubkey) => {
      const entry = this.accounts.get(pubkey.toBase58());
      if (!entry) {
        return null;
      }

      return {
        data: entry.data,
        executable: false,
        lamports: 0,
        owner: entry.owner,
        rentEpoch: 0,
      } as any;
    });
  }

  async getAccountInfo(pubkey: PublicKey) {
    const address = pubkey.toBase58();
    const mintOwner = this.mintOwners.get(address);
    if (mintOwner) {
      return {
        owner: mintOwner,
        data: Buffer.alloc(0),
        executable: false,
        lamports: 0,
      } as any;
    }

    const entry = this.accounts.get(address);
    if (!entry) {
      return null;
    }

    return {
      owner: entry.owner,
      data: entry.data,
      executable: false,
      lamports: 0,
    } as any;
  }

  async getParsedTokenAccountsByOwner(_owner: PublicKey, filter: any) {
    const program = filter?.programId?.toBase58?.() || "";
    this.parsedCalls.push(program);

    const value = Array.from(this.accounts.entries())
      .filter(([_, entry]) => entry.owner.toBase58() === program)
      .map(([address, entry]) => ({
        pubkey: new PublicKey(address),
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: {
                  amount: entry.amount.toString(),
                  decimals: entry.decimals,
                },
                mint: entry.mint.toBase58(),
              },
            },
          },
        },
      }));

    return { value } as any;
  }
}

describe("WalletManager.getAllApprovedTokenBalances", () => {
  test("returns filtered balances for approved tokens", async () => {
    const connection = new ConnParsed();
    const wm = WalletManager.createForTest(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );

    const owner = wm.getPublicKey(1n);
    connection.setOwner(owner);

    await connection.seedTokenAccount({
      mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      programId: TOKEN_PROGRAM_ID,
      amount: 1_000n,
      decimals: 6,
    });

    await connection.seedTokenAccount({
      mint: new PublicKey("So11111111111111111111111111111111111111112"),
      programId: TOKEN_2022_PROGRAM_ID,
      amount: 500_000_000n,
      decimals: 9,
    });

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
    expect(connection.parsedCalls.length).toBeGreaterThan(0);
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

  test("metadata failures are retried on subsequent balance lookups", async () => {
    const connection = new ConnParsed();
    const wm = WalletManager.createForTest(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );

    const owner = wm.getPublicKey(1n);
    connection.setOwner(owner);

    const mint = new PublicKey("4Nd1mFatW4Kfo7oyi7T5C5x64K8jKe3SWP7WRHnS8svB");
    await connection.seedTokenAccount({
      mint,
      programId: TOKEN_PROGRAM_ID,
      amount: 10_000n,
      decimals: 6,
    });

    const approved = [
      { token_mint: mint.toBase58(), token_ticker: "FALLBACK", decimals: 6 },
    ];

    let invocations = 0;
    let failures = 0;
    (wm as any).getFullTokenMetadata = async (_mint: string) => {
      invocations += 1;
      if (failures === 0) {
        failures += 1;
        throw new Error("temporary metadata failure");
      }
      return { decimals: 6, symbol: "META" };
    };

    const first = await wm.getAllApprovedTokenBalances(1n, approved);
    expect(first[0]?.ticker).toBe("META");
    expect(invocations).toBeGreaterThan(1);
    expect(failures).toBe(1);

    const cached = await wm.getAllApprovedTokenBalances(1n, approved);
    expect(cached[0]?.ticker).toBe("META");
    expect(failures).toBe(1);
  });

  test("persists detected program ids for approved tokens without hints", async () => {
    const connection = new ConnParsed();
    const persisted: Array<[string, string | null]> = [];
    const tokenDbStub = {
      setTokenProgramId(tokenMint: string, programId: string | null) {
        persisted.push([tokenMint, programId]);
      },
    } as unknown as TokenDatabase;

    const wm = WalletManager.createForTest(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      {
        connection: connection as any,
        fetch: globalThis.fetch as any,
        timeNow: () => Date.now(),
        tokenDb: tokenDbStub,
      }
    );

    const owner = wm.getPublicKey(1n);
    connection.setOwner(owner);

    const splMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const token2022Mint = new PublicKey("So11111111111111111111111111111111111111112");

    await connection.seedTokenAccount({
      mint: splMint,
      programId: TOKEN_PROGRAM_ID,
      amount: 1_000n,
      decimals: 6,
    });

    await connection.seedTokenAccount({
      mint: token2022Mint,
      programId: TOKEN_2022_PROGRAM_ID,
      amount: 1_000n,
      decimals: 9,
    });

    const approved = [
      { token_mint: splMint.toBase58(), token_ticker: "USDC", decimals: 6 },
      {
        token_mint: token2022Mint.toBase58(),
        token_ticker: "WSOL",
        decimals: 9,
        token_program_id: TOKEN_2022_PROGRAM_ID.toBase58(),
      },
    ];

    await wm.getAllApprovedTokenBalances(1n, approved);

    expect(persisted).toEqual([[splMint.toBase58(), TOKEN_PROGRAM_ID.toBase58()]]);
    expect(approved[0]?.token_program_id).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});
