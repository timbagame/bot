import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair, SystemProgram, type TransactionInstruction } from "#solana";
import { WalletManager } from "../src/utils/wallet";
import { USER_SOL_MAX_BUFFER_LAMPORTS } from "../src/utils/constants";
import { storePendingTransaction } from "../src/utils/user-state";
import {
  answers,
  lastText,
  press,
  resetCalls,
  restoreStubs,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";

let userId = 920_000;
const fullBalance = 3_000_000;
const rent = 2_039_280;

beforeEach(() => {
  useBotHarness();
  resetCalls();
  userId += 1;
});
afterEach(() => restoreStubs());

async function prepare(nativeBalance: bigint | number) {
  const user = await Keypair.generate();
  const operator = await Keypair.generate();
  let operatorLoads = 0;
  const submissions: Array<{
    instructions: TransactionInstruction[];
    signers: Keypair[];
    options: unknown;
  }> = [];
  // Keep the complete production flow through both public wallet unwrap methods.
  stub(wallet, "unwrapSol", WalletManager.prototype.unwrapSol.bind(wallet));
  stub(wallet, "unwrapSolWithKeypair", WalletManager.prototype.unwrapSolWithKeypair.bind(wallet));
  stub(wallet, "connection", { getBalance: async () => nativeBalance });
  stub(wallet, "getKeyPair", async () => user);
  stub(wallet, "getOperatorKeypair", async () => {
    operatorLoads += 1;
    return operator;
  });
  stub(wallet, "buildUnwrapWsolPlan", async ({ amountLamports }: { amountLamports?: number }) => ({
    instructions: [
      SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: user.publicKey, lamports: 0 }),
    ],
    unwrapLamports: amountLamports ?? fullBalance,
    remainingLamports: fullBalance - (amountLamports ?? fullBalance),
    payerRentLamports: amountLamports !== undefined && amountLamports < fullBalance ? rent : 0,
  }));
  stub(wallet, "estimateFee", async () => 5_000);
  stub(
    wallet,
    "sendAndConfirmWithResubmits",
    async (instructions: TransactionInstruction[], signers: Keypair[], options: unknown) => {
      submissions.push({ instructions, signers, options });
      return "unwrap-flow-signature";
    },
  );
  stub(wallet, "confirmTransaction", async () => {});
  return { user, operator, submissions, operatorLoads: () => operatorLoads };
}

async function confirmSwap(amount: number) {
  const id = `sponsored-unwrap-${userId}`;
  storePendingTransaction(id, {
    type: "swap",
    userId: String(userId),
    fromToken: "WSOL",
    toToken: "SOL",
    amount: String(amount / 1e9),
    rawAmount: String(amount),
    inputDecimals: 9,
    outputDecimals: 9,
    cancelCallback: "cancel",
    quote: {},
  });
  await press(`confirm_swap_${id}`, { userId });
}

describe("Telegram unwrap sponsorship", () => {
  for (const amount of [1_000_000, fullBalance]) {
    test(`zero-SOL swap confirmation sponsors ${amount} and atomically reimburses the operator`, async () => {
      const fixture = await prepare(0n);
      await confirmSwap(amount);
      expect(answers()).toContain("✅ Unwrapped WSOL to SOL");
      expect(fixture.operatorLoads()).toBe(1);
      expect(fixture.submissions).toHaveLength(1);
      const sent = fixture.submissions[0]!;
      expect(sent.signers).toEqual([fixture.operator, fixture.user]);
      expect(sent.options).toEqual({ operationLabel: "Unwrap WSOL", maxResubmits: 0 });
      const reimbursement = sent.instructions.at(-1)!;
      expect(reimbursement.keys[0]!.pubkey).toEqual(fixture.user.publicKey);
      expect(reimbursement.keys[1]!.pubkey).toEqual(fixture.operator.publicKey);
      expect(Buffer.from(reimbursement.data).readBigUInt64LE(4)).toBe(
        BigInt(5_000 + (amount < fullBalance ? rent : 0)),
      );
    });

    test(`funded swap confirmation unwraps ${amount} without requesting sponsorship`, async () => {
      const fixture = await prepare(BigInt(USER_SOL_MAX_BUFFER_LAMPORTS));
      await confirmSwap(amount);
      expect(answers()).toContain("✅ Unwrapped WSOL to SOL");
      expect(fixture.operatorLoads()).toBe(0);
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]!.signers).toEqual([fixture.user]);
      expect(fixture.submissions[0]!.instructions).toHaveLength(1);
    });
  }

  test("the direct unwrap confirmation also sponsors a zero-SOL wallet", async () => {
    const fixture = await prepare(0n);
    await press("unwrap_confirm", { userId });
    expect(answers()).toContain("✅ WSOL unwrapped");
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0]!.signers).toEqual([fixture.operator, fixture.user]);
  });

  for (const balance of [499_999n, 5_000n]) {
    test(`a wallet with ${balance} native lamports can unwrap dust without sponsorship`, async () => {
      const fixture = await prepare(balance);
      await confirmSwap(1);
      expect(answers()).toContain("✅ Unwrapped WSOL to SOL");
      expect(fixture.operatorLoads()).toBe(0);
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]!.signers).toEqual([fixture.user]);
    });
  }

  test("a native balance just below the actual fee requests sponsorship", async () => {
    const fixture = await prepare(4_999n);
    await confirmSwap(fullBalance);
    expect(answers()).toContain("✅ Unwrapped WSOL to SOL");
    expect(fixture.operatorLoads()).toBe(1);
    expect(fixture.submissions[0]!.signers).toEqual([fixture.operator, fixture.user]);
  });

  test("a failed fee estimate reports an error without submitting a transaction", async () => {
    const fixture = await prepare(5_000n);
    stub(wallet, "estimateFee", async () => {
      throw new Error("RPC returned no transaction fee estimate.");
    });
    await confirmSwap(fullBalance);
    expect(answers()).toContain("❌ Unwrap failed");
    expect(fixture.operatorLoads()).toBe(0);
    expect(fixture.submissions).toHaveLength(0);
  });

  test("a missing sponsor reports an error without sending a user-paid transaction", async () => {
    const fixture = await prepare(0n);
    stub(wallet, "getOperatorKeypair", async () => {
      throw new Error("Operator keypair file not found");
    });
    await confirmSwap(fullBalance);
    expect(answers()).toContain("❌ Unwrap failed");
    expect(fixture.submissions).toHaveLength(0);
  });

  test("an invalid native balance cannot bypass the sponsorship decision", async () => {
    const fixture = await prepare(Number.NaN);
    await confirmSwap(fullBalance);
    expect(answers()).toContain("❌ Unwrap failed");
    expect(fixture.submissions).toHaveLength(0);
    expect(lastText()).not.toContain("Unwrap Completed");
  });
});
