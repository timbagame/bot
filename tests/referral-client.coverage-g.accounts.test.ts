import { describe, expect, test } from "bun:test";
import { Keypair, type Connection } from "#solana";
import { REFERRAL_PROGRAM_ID, ReferralProvider } from "../src/utils/referral-client";

const REFERRAL_ACCOUNT_DISCRIMINATOR = Buffer.from([237, 162, 80, 78, 196, 233, 91, 2]);

const accountInfo = (owner: unknown, data: Uint8Array) =>
  ({ data, executable: false, lamports: 1n, owner, rentEpoch: 0n }) as any;

describe("claimAllV2 account ownership checks", () => {
  test("a missing referral account is rejected", async () => {
    const connection = { getAccountInfo: async () => null } as unknown as Connection;
    await expect(
      new ReferralProvider(connection).claimAllV2({
        payerPubKey: (await Keypair.generate()).publicKey,
        referralAccountPubKey: (await Keypair.generate()).publicKey,
      }),
    ).rejects.toThrow("Invalid Jupiter referral account");
  });

  test("a referral account owned by another program is rejected", async () => {
    const other = (await Keypair.generate()).publicKey;
    const connection = {
      getAccountInfo: async () => accountInfo(other, Buffer.alloc(72)),
    } as unknown as Connection;
    await expect(
      new ReferralProvider(connection).claimAllV2({
        payerPubKey: (await Keypair.generate()).publicKey,
        referralAccountPubKey: (await Keypair.generate()).publicKey,
      }),
    ).rejects.toThrow("Invalid Jupiter referral account");
  });

  const projectChecks = async (projectInfo: (other: unknown) => unknown) => {
    const referralAddress = (await Keypair.generate()).publicKey;
    const projectAddress = (await Keypair.generate()).publicKey;
    const other = (await Keypair.generate()).publicKey;
    const referralData = Buffer.alloc(72);
    REFERRAL_ACCOUNT_DISCRIMINATOR.copy(referralData);
    projectAddress.toBuffer().copy(referralData, 40);
    const connection = {
      getAccountInfo: async (address: typeof referralAddress) =>
        address.equals(referralAddress)
          ? accountInfo(REFERRAL_PROGRAM_ID, referralData)
          : projectInfo(other),
    } as unknown as Connection;
    await expect(
      new ReferralProvider(connection).claimAllV2({
        payerPubKey: (await Keypair.generate()).publicKey,
        referralAccountPubKey: referralAddress,
      }),
    ).rejects.toThrow("Invalid Jupiter referral project");
  };

  test("a missing project account is rejected", () => projectChecks(() => null));

  test("a project account owned by another program is rejected", () =>
    projectChecks((other) => accountInfo(other, Buffer.alloc(72))));
});
