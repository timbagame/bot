import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import { __test_runReferralSweep } from "../src/services/fee-sweeper";

const referral = "11111111111111111111111111111111";

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});
const logged = (text: string) =>
  logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

const setup = async (decimals: number, amount: bigint) => {
  const payer = await Keypair.generate();
  const mint = (await Keypair.generate()).publicKey;
  const accountKey = (await Keypair.generate()).publicKey;
  const connection = {
    getParsedAccountInfo: async () => ({
      value: { data: { program: "spl-token", parsed: { info: { decimals } } } },
    }),
  };
  const claimCalls: unknown[] = [];
  const provider = {
    getReferralTokenAccountsV2: async () => ({
      tokenAccounts: [{ pubkey: accountKey, account: { mint, amount } }],
      token2022Accounts: [],
    }),
    claimAllV2: async (args: unknown) => {
      claimCalls.push(args);
      return [];
    },
  };
  const price = async () => ({ price: 1, identifier: "x", resolvedAt: Date.now() }) as any;
  return { payer, connection, provider, claimCalls, price };
};

describe("referral sweep uses on-chain mint decimals", () => {
  test("values the balance with the parsed decimals and proceeds to claim", async () => {
    // 10 tokens at 6 decimals * $1 = $10, above the $5 threshold. With the 9-decimal
    // fallback the same raw amount would be worth $0.01 and be skipped.
    const s = await setup(6, 10_000_000n);

    const claimed = await __test_runReferralSweep(
      s.connection as any,
      s.payer,
      referral,
      s.price,
      () => s.provider as any,
    );

    expect(claimed).toBe(0);
    expect(s.claimCalls).toHaveLength(1);
    expect(logged("Collecting Jupiter referral fees (~$10.00)")).toBe(true);
  });

  test("skips the claim when the parsed decimals make the balance tiny", async () => {
    // 10_000_000 raw at 9 decimals is 0.01 tokens, below the $5 threshold.
    const s = await setup(9, 10_000_000n);

    const claimed = await __test_runReferralSweep(
      s.connection as any,
      s.payer,
      referral,
      s.price,
      () => s.provider as any,
    );

    expect(claimed).toBe(0);
    expect(s.claimCalls).toHaveLength(0);
    expect(logged("Skipping referral claim: total value ≈ $0.01")).toBe(true);
  });
});
