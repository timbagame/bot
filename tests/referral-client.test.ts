import { describe, expect, test } from "bun:test";
import { Keypair, type Connection, type PublicKey } from "#solana";
import { ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, AccountState, TOKEN_PROGRAM_ID } from "#token";
import { REFERRAL_PROGRAM_ID, ReferralProvider } from "../src/utils/referral-client";

const REFERRAL_ACCOUNT_DISCRIMINATOR = Buffer.from([237, 162, 80, 78, 196, 233, 91, 2]);
const PROJECT_DISCRIMINATOR = Buffer.from([205, 168, 189, 202, 181, 247, 142, 19]);

const accountInfo = (owner: ReturnType<typeof Keypair.generate>["publicKey"], data: Uint8Array) =>
  ({ data, executable: false, lamports: 1n, owner, rentEpoch: 0n }) as any;

const referralAccountData = (partner: PublicKey, project: PublicKey): Buffer => {
  const data = Buffer.alloc(72);
  REFERRAL_ACCOUNT_DISCRIMINATOR.copy(data);
  partner.toBuffer().copy(data, 8);
  project.toBuffer().copy(data, 40);
  return data;
};

const projectData = (base: PublicKey, admin: PublicKey): Buffer => {
  const data = Buffer.alloc(72);
  PROJECT_DISCRIMINATOR.copy(data);
  base.toBuffer().copy(data, 8);
  admin.toBuffer().copy(data, 40);
  return data;
};

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

    const referralData = referralAccountData(partner, projectAddress);
    const projectAccountData = projectData(projectBase, projectAdmin);
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
        if (address.equals(projectAddress))
          return accountInfo(REFERRAL_PROGRAM_ID, projectAccountData);
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
      getAddressLookupTable: async () => ({ value: null }),
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

  test("batches four token claims within the transaction size limit", async () => {
    const payer = Keypair.generate().publicKey;
    const referralAddress = Keypair.generate().publicKey;
    const partner = Keypair.generate().publicKey;
    const projectAddress = Keypair.generate().publicKey;
    const projectBase = Keypair.generate().publicKey;
    const projectAdmin = Keypair.generate().publicKey;
    const referralData = referralAccountData(partner, projectAddress);
    const projectAccountData = projectData(projectBase, projectAdmin);
    const tokenAccounts = Array.from({ length: 5 }, () => {
      const pubkey = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode(
        { mint, owner: referralAddress, amount: 10n, state: AccountState.Initialized },
        data,
      );
      return { pubkey, account: accountInfo(TOKEN_PROGRAM_ID, data) };
    });
    const connection = {
      getAccountInfo: async (address: typeof referralAddress) => {
        if (address.equals(referralAddress)) return accountInfo(REFERRAL_PROGRAM_ID, referralData);
        if (address.equals(projectAddress))
          return accountInfo(REFERRAL_PROGRAM_ID, projectAccountData);
        return null;
      },
      getTokenAccountsByOwner: async (
        _owner: typeof referralAddress,
        filter: { programId: typeof TOKEN_PROGRAM_ID },
      ) => ({ value: filter.programId.equals(TOKEN_PROGRAM_ID) ? tokenAccounts : [] }),
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1n,
      }),
      getAddressLookupTable: async () => ({ value: null }),
    } as unknown as Connection;

    const transactions = await new ReferralProvider(connection).claimAllV2({
      payerPubKey: payer,
      referralAccountPubKey: referralAddress,
    });

    expect(transactions).toHaveLength(2);
    expect(transactions.map(({ message }) => message.compiledInstructions.length)).toEqual([12, 3]);
    expect(transactions[0]!.serialize().length).toBeLessThanOrEqual(1_232);
  });

  test("rejects a referral account with the wrong discriminator", async () => {
    const referralAddress = Keypair.generate().publicKey;
    const connection = {
      getAccountInfo: async () => accountInfo(REFERRAL_PROGRAM_ID, Buffer.alloc(72)),
    } as unknown as Connection;

    await expect(
      new ReferralProvider(connection).claimAllV2({
        payerPubKey: Keypair.generate().publicKey,
        referralAccountPubKey: referralAddress,
      }),
    ).rejects.toThrow("Invalid Jupiter referral account");
  });

  test("rejects a project account with the wrong discriminator", async () => {
    const referralAddress = Keypair.generate().publicKey;
    const projectAddress = Keypair.generate().publicKey;
    const referralData = referralAccountData(Keypair.generate().publicKey, projectAddress);
    const connection = {
      getAccountInfo: async (address: typeof referralAddress) =>
        accountInfo(
          REFERRAL_PROGRAM_ID,
          address.equals(referralAddress) ? referralData : Buffer.alloc(72),
        ),
    } as unknown as Connection;

    await expect(
      new ReferralProvider(connection).claimAllV2({
        payerPubKey: Keypair.generate().publicKey,
        referralAccountPubKey: referralAddress,
      }),
    ).rejects.toThrow("Invalid Jupiter referral project");
  });
});
