import { describe, expect, test } from "bun:test";
import { getMintEncoder as getSplMintEncoder } from "@solana-program/token";
import { getMintEncoder as getMint2022Encoder } from "@solana-program/token-2022";
import { PublicKey } from "../src/utils/solana";
import {
  AccountLayout,
  AccountState,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  getAccount,
  getDefaultAccountState,
  getMinimumBalanceForRentExemptAccount,
  getNonTransferable,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  unpackAccount,
  unpackMint,
} from "../src/utils/token-kit";

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));
const none = { __option: "None" } as const;
const some = <T>(value: T) => ({ __option: "Some", value }) as const;
const info = (owner: PublicKey, data: Uint8Array) =>
  ({ owner, data, executable: false, lamports: 1 }) as any;

describe("unpackMint", () => {
  test("decodes a classic SPL mint without extensions", () => {
    const authority = key(9);
    const data = getSplMintEncoder().encode({
      mintAuthority: some(authority.toBase58()),
      supply: 1_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthority: none,
    } as any);

    const mint = unpackMint(key(1), info(TOKEN_PROGRAM_ID, Uint8Array.from(data)));

    expect(mint.address.toBase58()).toBe(key(1).toBase58());
    expect(mint.decimals).toBe(6);
    expect(mint.supply).toBe(1_000n);
    expect(mint.mintAuthority).toBe(authority.toBase58());
    expect(mint.freezeAuthority).toBeNull();
    expect(mint.extensions).toEqual([]);
    expect(getPermanentDelegate(mint)).toBeUndefined();
  });

  test("decodes Token-2022 extensions and exposes them through the getters", () => {
    const delegate = key(7).toBase58();
    const data = getMint2022Encoder().encode({
      mintAuthority: none,
      supply: 0n,
      decimals: 9,
      isInitialized: true,
      freezeAuthority: none,
      extensions: some([
        { __kind: "PermanentDelegate", delegate },
        { __kind: "NonTransferable" },
        { __kind: "DefaultAccountState", state: AccountState.Frozen },
      ]),
    } as any);

    const mint = unpackMint(
      key(2),
      info(TOKEN_2022_PROGRAM_ID, Uint8Array.from(data)),
      TOKEN_2022_PROGRAM_ID,
    );

    expect(mint.decimals).toBe(9);
    expect(getPermanentDelegate(mint)).toMatchObject({ __kind: "PermanentDelegate", delegate });
    expect(getNonTransferable(mint)).toEqual({ __kind: "NonTransferable" });
    expect(getDefaultAccountState(mint)).toMatchObject({ state: AccountState.Frozen });
    expect(getTransferHook(mint)).toBeUndefined();
    expect(getTransferFeeConfig(mint)).toBeUndefined();
  });

  test("a Token-2022 mint without extensions has an empty list", () => {
    const data = getMint2022Encoder().encode({
      mintAuthority: none,
      supply: 0n,
      decimals: 0,
      isInitialized: true,
      freezeAuthority: none,
      extensions: none,
    } as any);

    const mint = unpackMint(
      key(3),
      info(TOKEN_2022_PROGRAM_ID, Uint8Array.from(data)),
      TOKEN_2022_PROGRAM_ID,
    );

    expect(mint.extensions).toEqual([]);
  });

  test("rejects a mint owned by the other token program", () => {
    const data = getSplMintEncoder().encode({
      mintAuthority: none,
      supply: 0n,
      decimals: 0,
      isInitialized: true,
      freezeAuthority: none,
    } as any);

    expect(() =>
      unpackMint(key(4), info(TOKEN_PROGRAM_ID, Uint8Array.from(data)), TOKEN_2022_PROGRAM_ID),
    ).toThrow(TokenInvalidAccountOwnerError);
  });
});

describe("token accounts", () => {
  const encoded = () => {
    const data = new Uint8Array(AccountLayout.span);
    AccountLayout.encode(
      { mint: key(1), owner: key(2), amount: 42n, state: AccountState.Initialized },
      data,
    );
    return data;
  };

  test("getAccount decodes an existing account at the requested commitment", async () => {
    const calls: unknown[][] = [];
    const connection = {
      getAccountInfo: async (...args: unknown[]) => {
        calls.push(args);
        return info(TOKEN_PROGRAM_ID, encoded());
      },
    } as any;

    const account = await getAccount(connection, key(5), "finalized");

    expect(account.amount).toBe(42n);
    expect(account.mint.toBase58()).toBe(key(1).toBase58());
    expect(account.owner.toBase58()).toBe(key(2).toBase58());
    expect(calls[0]![1]).toBe("finalized");
  });

  test("getAccount reports a missing account", async () => {
    const connection = { getAccountInfo: async () => null } as any;

    await expect(getAccount(connection, key(5))).rejects.toThrow(TokenAccountNotFoundError);
  });

  test("unpackAccount rejects a foreign owner", () => {
    expect(() => unpackAccount(key(5), info(key(8), encoded()))).toThrow(
      `Token account is owned by ${key(8).toBase58()}, not ${TOKEN_PROGRAM_ID.toBase58()}`,
    );
  });
});

describe("getMinimumBalanceForRentExemptAccount", () => {
  test("asks for the rent of a 165-byte token account", async () => {
    let requested: unknown;
    const connection = {
      getMinimumBalanceForRentExemption: async (span: number) => {
        requested = span;
        return 2_039_280n;
      },
    } as any;

    expect(await getMinimumBalanceForRentExemptAccount(connection)).toBe(2_039_280);
    expect(requested).toBe(165);
  });

  test.each([0, -1, Number.NaN, 2 ** 60])("rejects an unusable rent value %p", async (value) => {
    const connection = { getMinimumBalanceForRentExemption: async () => value } as any;

    await expect(getMinimumBalanceForRentExemptAccount(connection)).rejects.toThrow(
      "Token account rent reserve unavailable",
    );
  });
});
