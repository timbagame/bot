import { expect, test, describe } from "bun:test";
import { WalletManager } from "../src/utils/wallet";
import { PublicKey } from "@solana/web3.js";
import {
  AccountLayout,
  AccountState,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

// Minimal Response-like factory
const makeResponse = (ok: boolean, status: number, body: any) => ({
  ok,
  status,
  json: async () => body,
});

function makeMockFetch() {
  return async (input: string) => {
    const url = String(input);
    if (url.includes("api.jup.ag/tokens/v2/search")) {
      return makeResponse(true, 200, [
        {
          id: "11111111111111111111111111111111",
          symbol: "JUPSYM",
          name: "Jupiter Token",
          decimals: 9,
        },
      ]);
    }
    return makeResponse(false, 404, {});
  };
}

function makeMockConnection() {
  const calls = { getLatestBlockhash: 0 };
  let tokenAccountsSPL: any[] = [];
  let tokenAccounts2022: any[] = [];
  const decimalsByMint: Record<string, number> = {};
  let owner: PublicKey | null = null;
  let ataCacheDirty = true;
  const ataCache = new Map<
    string,
    { programId: PublicKey; amount: string; decimals: number; mint: string }
  >();

  const markDirty = () => {
    ataCacheDirty = true;
  };

  const ensureAtaCache = async () => {
    if (!ataCacheDirty || !owner) {
      return;
    }

    ataCache.clear();

    const populate = async (accounts: any[], programId: PublicKey) => {
      for (const entry of accounts) {
        const parsed = entry.account?.data?.parsed;
        if (!parsed) continue;
        const info = parsed.info;
        const mint = info?.mint;
        const tokenAmount = info?.tokenAmount;
        if (!mint || !tokenAmount) continue;

        const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner!, false, programId);

        ataCache.set(ata.toBase58(), {
          programId,
          amount: String(tokenAmount.amount ?? "0"),
          decimals: Number(tokenAmount.decimals ?? 0),
          mint,
        });
      }
    };

    await populate(tokenAccountsSPL, TOKEN_PROGRAM_ID);
    await populate(tokenAccounts2022, TOKEN_2022_PROGRAM_ID);

    ataCacheDirty = false;
  };

  return {
    calls,
    setOwner(pk: PublicKey) {
      owner = pk;
      markDirty();
    },
    setTokenAccounts(arr: any[]) {
      tokenAccountsSPL = arr;
      markDirty();
    },
    setTokenAccounts2022(arr: any[]) {
      tokenAccounts2022 = arr;
      markDirty();
    },
    setDecimals(mint: string, d: number) {
      decimalsByMint[mint] = d;
    },
    async getLatestBlockhash() {
      calls.getLatestBlockhash++;
      return { blockhash: "BH123", lastValidBlockHeight: 42 } as any;
    },
    async getParsedTokenAccountsByOwner(_owner: any, filter: any) {
      if (_owner instanceof PublicKey) {
        owner = _owner;
        markDirty();
      }
      const pid = filter?.programId?.toBase58?.() ?? String(filter?.programId);
      if (pid?.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) {
        return { value: tokenAccountsSPL } as any;
      }
      return { value: tokenAccounts2022 } as any;
    },
    async getMultipleAccountsInfo(pubkeys: PublicKey[]) {
      await ensureAtaCache();

      return pubkeys.map((pk) => {
        const cached = ataCache.get(pk.toBase58());
        if (!cached) {
          return null;
        }

        const buffer = Buffer.alloc(AccountLayout.span);
        AccountLayout.encode(
          {
            mint: new PublicKey(cached.mint),
            owner: owner!,
            amount: BigInt(cached.amount),
            delegateOption: 0,
            delegate: owner!,
            state: AccountState.Initialized,
            isNativeOption: 0,
            isNative: 0n,
            delegatedAmount: 0n,
            closeAuthorityOption: 0,
            closeAuthority: owner!,
          } as any,
          buffer,
        );

        return {
          data: buffer,
          executable: false,
          lamports: 0,
          owner: cached.programId,
          rentEpoch: 0,
        } as any;
      });
    },
    async getParsedAccountInfo(mintPk: PublicKey) {
      const mint = mintPk.toBase58();
      const d = decimalsByMint[mint] ?? 6;
      return { value: { data: { parsed: { info: { decimals: d } } } } } as any;
    },
    async getAccountInfo(_pk: PublicKey) {
      // Force metaplex path to be skipped for predictability
      return null as any;
    },
  } as any;
}

describe("WalletManager dependency injection", () => {
  test("getLatestBlockhash uses cache within duration", async () => {
    const now = 1000;
    const conn = makeMockConnection();
    const wm = WalletManager.createForTest("test mnemonic", {
      connection: conn,
      fetch: makeMockFetch(),
      timeNow: () => now,
    });

    const a = await wm.getLatestBlockhash();
    const b = await wm.getLatestBlockhash();
    expect(a.blockhash).toBe("BH123");
    expect(b.blockhash).toBe("BH123");
    expect((conn as any).calls.getLatestBlockhash).toBe(1);
  });

  test("getFullTokenMetadata falls back to Jupiter and reads decimals via RPC", async () => {
    const conn = makeMockConnection();
    const mint = "11111111111111111111111111111111"; // valid base58, not in knownTokens
    (conn as any).setDecimals(mint, 9);
    const wm = WalletManager.createForTest("test mnemonic", {
      connection: conn,
      fetch: makeMockFetch(),
      timeNow: () => 0,
    });

    const meta = await wm.getFullTokenMetadata(mint);
    expect(meta.decimals).toBe(9);
    expect(meta.symbol).toBe("JUPSYM");
    expect(meta.name).toBe("Jupiter Token");
  });

  test("getAllApprovedTokenBalances returns filtered results sorted by ticker", async () => {
    const conn = makeMockConnection();
    const acc = (mint: string, amount: string, decimals = 6) => ({
      account: {
        data: {
          parsed: {
            info: { mint, tokenAmount: { amount, decimals } },
          },
        },
      },
    });
    // Use valid base58 mints to avoid PublicKey decode errors in metadata path
    const MINT_A = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const MINT_B = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT
    (conn as any).setTokenAccounts([
      acc(MINT_B, "2000000", 6), // 2.0
      acc(MINT_A, "1000000", 6), // 1.0
    ]);
    (conn as any).setTokenAccounts2022([]);

    // Use a fetch that always fails to ensure we keep approved tickers (no override)
    const failingFetch = async () => makeResponse(false, 404, {});
    const wm = WalletManager.createForTest("test mnemonic", {
      connection: conn,
      fetch: failingFetch as any,
      timeNow: () => 0,
    });

    (conn as any).setOwner(wm.getPublicKey(1n));

    const approved = [
      { token_mint: MINT_A, token_ticker: "AAA", decimals: 6 },
      { token_mint: MINT_B, token_ticker: "BBB", decimals: 6 },
    ];

    const list = await wm.getAllApprovedTokenBalances(1n, approved);
    // Sorted by ticker asc: AAA then BBB
    expect(list.map((i) => i.ticker)).toEqual(["AAA", "BBB"]);
    expect(list.map((i) => i.mint)).toEqual([MINT_A, MINT_B]);
    expect(list[0]!.rawBalance).toBe("1000000");
    expect(list[1]!.rawBalance).toBe("2000000");
  });
});
