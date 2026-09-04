import { describe, expect, test } from "bun:test";
import { Keypair, type Connection } from "#solana";
import { ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, AccountState, TOKEN_PROGRAM_ID } from "#token";
import { REFERRAL_PROGRAM_ID, ReferralProvider } from "../src/utils/referral-client";

const accountInfo = (owner: ReturnType<typeof Keypair.generate>["publicKey"], data: Uint8Array) =>
  ({ data, executable: false, lamports: 1n, owner, rentEpoch: 0n }) as any;

describe("Kit Jupiter referral client", () => {
  test("builds the create-admin-account and claim-v2 instructions", async () => {
    const payer = Keypair.generate().publicKey;
    const referralAddress = Keypair.generate().publicKey;
    const partner = Keypair.generate().publicKey;
    const projectAddress = Keypair.generate().publicKey;
    const projectBase = Keypair.generate().publicKey;
    const projectAdmin = Keypair.generate().publicKey;
    const referralTokenAddress = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;

    const referralData = Buffer.alloc(72);
    partner.toBuffer().copy(referralData, 8);
    projectAddress.toBuffer().copy(referralData, 40);
    const projectData = Buffer.alloc(72);
    projectBase.toBuffer().copy(projectData, 8);
    projectAdmin.toBuffer().copy(projectData, 40);
    const tokenData = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint,
        owner: referralAddress,
        amount: 10n,
        state: AccountState.Initialized,
      },
      tokenData,
    );

    const connection = {
      getAccountInfo: async (address: typeof referralAddress) => {
        if (address.equals(referralAddress)) return accountInfo(REFERRAL_PROGRAM_ID, referralData);
        if (address.equals(projectAddress)) return accountInfo(REFERRAL_PROGRAM_ID, projectData);
        return null;
      },
      getTokenAccountsByOwner: async (
        _owner: typeof referralAddress,
        filter: { programId: typeof TOKEN_PROGRAM_ID },
      ) => ({
        value: filter.programId.equals(TOKEN_PROGRAM_ID)
          ? [
              {
                pubkey: referralTokenAddress,
                account: accountInfo(TOKEN_PROGRAM_ID, tokenData),
              },
            ]
          : [],
      }),
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1n,
      }),
    } as unknown as Connection;

    const transactions = await new ReferralProvider(connection).claimAllV2({
      payerPubKey: payer,
      referralAccountPubKey: referralAddress,
    });

    expect(transactions).toHaveLength(1);
    const message = transactions[0]!.message;
    const instructions = message.compiledInstructions;
    expect(instructions).toHaveLength(3);
    expect(
      instructions.map((instruction) =>
        message.staticAccountKeys[instruction.programIdIndex]!.toBase58(),
      ),
    ).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      REFERRAL_PROGRAM_ID.toBase58(),
      REFERRAL_PROGRAM_ID.toBase58(),
    ]);
    expect([...instructions[1]!.data]).toEqual([102, 86, 232, 205, 140, 111, 8, 116]);
    expect([...instructions[2]!.data]).toEqual([229, 87, 46, 162, 21, 157, 231, 114]);
  });
});
