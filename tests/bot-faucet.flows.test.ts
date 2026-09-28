import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import {
  botModule,
  buttons,
  callsTo,
  lastText,
  press,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";
import { TransactionOutcomeUnknownError } from "../src/utils/wallet";

useBotHarness();

let GROUP = -3_300_000;
let CREATOR = 81_000;
const LAMPORTS = 1_000_000_000;
const TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

let parsed: any;
let savedTokenManager: any;
let recipient: string;
let transferSol: ReturnType<typeof mock>;
let transferToken: ReturnType<typeof mock>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

const solAmount = {
  amount: LAMPORTS / 10,
  isSol: true,
  formattedAmount: "0.1 SOL",
  tokenMint: "So11111111111111111111111111111111111111112",
  tokenTicker: "SOL",
  decimals: 9,
  tokenWasSpecified: true,
  requestedNativeSol: true,
};

beforeEach(async () => {
  GROUP -= 1;
  CREATOR += 10;
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  parsed = { success: true, data: solAmount };
  savedTokenManager = botModule.__test_getTokenManager();
  botModule.__test_setTokenManager({ parseAmount: async () => parsed } as any);
  recipient = (await Keypair.generate()).publicKey.toBase58();
  stub(wallet, "getPublicKey", async () => recipient);
  stub(wallet, "getBalance", async () => 5 * LAMPORTS);
  stub(wallet, "getTokenBalance", async () => 1_000_000);
  transferSol = mock(async (_from: bigint, _to: unknown, _amount: number, onPrepared: any) => {
    await onPrepared?.("sol-claim-sig");
    return "sol-claim-sig";
  });
  transferToken = mock(
    async (_from: bigint, _to: unknown, _amount: number, _mint: string, onPrepared: any) => {
      await onPrepared?.("token-claim-sig");
      return "token-claim-sig";
    },
  );
  stub(wallet, "transferSol", transferSol);
  stub(wallet, "transferToken", transferToken);
});

afterEach(() => {
  botModule.__test_setTokenManager(savedTokenManager);
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

/** Create a faucet and return its claim button data and card message id. */
const createFaucet = async (text = "/faucet 0.1 SOL 2") => {
  await sendText(text, { userId: CREATOR, chatId: GROUP });
  const card = callsTo("sendMessage").at(-1)!;
  const claim = buttons(card).find((button) => button.data?.startsWith("faucet:claim:"))!;
  return { claim: claim.data, messageId: card.result.message_id as number };
};

const collect = (claim: string, messageId: number, userId: number) =>
  press(claim, { userId, chatId: GROUP, messageId });

describe("/faucet in the bot", () => {
  test("creating a SOL faucet checks the native balance", async () => {
    const getBalance = mock(async () => 5 * LAMPORTS);
    stub(wallet, "getBalance", getBalance);

    const { claim } = await createFaucet();

    expect(claim).toMatch(/^faucet:claim:\d+$/);
    expect((getBalance.mock.calls[0] as any[])[1]).toEqual({ forceFresh: true });
  });

  test("a claim pays the claimant in SOL", async () => {
    const { claim, messageId } = await createFaucet();

    await collect(claim, messageId, CREATOR + 1);

    expect(transferSol).toHaveBeenCalledTimes(1);
    const [from, to, amount] = transferSol.mock.calls[0] as any[];
    expect(from).toBe(BigInt(CREATOR));
    expect(String(to)).toBe(recipient);
    expect(amount).toBe(LAMPORTS / 10);
  });

  test("token faucets check and transfer the SPL token", async () => {
    parsed = {
      success: true,
      data: {
        ...solAmount,
        amount: 50_000,
        isSol: false,
        formattedAmount: "0.5 BONK",
        tokenMint: TOKEN_MINT,
        tokenTicker: "BONK",
        decimals: 5,
        requestedNativeSol: false,
      },
    };
    const getTokenBalance = mock(async () => 1_000_000);
    stub(wallet, "getTokenBalance", getTokenBalance);

    const { claim, messageId } = await createFaucet("/faucet 0.5 BONK 2");
    await collect(claim, messageId, CREATOR + 1);

    expect((getTokenBalance.mock.calls[0] as any[]).slice(1)).toEqual([
      TOKEN_MINT,
      { createIfMissing: false, throwOnError: true },
    ]);
    expect((transferToken.mock.calls[0] as any[]).slice(2, 4)).toEqual([50_000, TOKEN_MINT]);
  });

  test("invalid amounts show the faucet usage", async () => {
    parsed = { success: false, error: "invalid_amount" };

    await sendText("/rain lots", { userId: CREATOR, chatId: GROUP });

    expect(lastText()).toContain("Usage: <code>/faucet &lt;amount&gt; [USD|TOKEN] [users]</code>");
  });

  test("a transfer with an unknown outcome is reconciled from the chain later", async () => {
    stub(wallet, "transferSol", async (...args: any[]) => {
      await args[3]?.("pending-sig");
      throw new TransactionOutcomeUnknownError("pending-sig", "confirmation timed out");
    });
    const outcomes = mock(async () => "confirmed" as const);
    stub(wallet, "getTransactionOutcome", outcomes);
    const { claim, messageId } = await createFaucet();

    await collect(claim, messageId, CREATOR + 1);
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).startsWith("Faucet payment confirmation pending"),
      ),
    ).toBe(true);

    await botModule.__test_faucetModule.expireDue();

    expect(outcomes).toHaveBeenCalledWith("pending-sig");
  });
});
