import { getProgramDerivedAddress } from "@solana/kit";
import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "#solana";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  unpackAccount,
} from "#token";

export const REFERRAL_PROGRAM_ID = new PublicKey("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3");
const REFERRAL_LOOKUP_TABLE = new PublicKey("GBzQG2iFrPwXjGtCnwNt9S5eHd8xAR8jUMt3QDJpnjud");
const CLAIMS_PER_TRANSACTION = 4;

export type ReferralTokenAccount = {
  pubkey: PublicKey;
  account: ReturnType<typeof unpackAccount>;
};

type ReferralAccount = {
  partner: PublicKey;
  project: PublicKey;
};

type Project = {
  base: PublicKey;
  admin: PublicKey;
};

const discriminator = (namespace: "account" | "global", name: string): Buffer =>
  createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);

const REFERRAL_ACCOUNT_DISCRIMINATOR = discriminator("account", "ReferralAccount");
const PROJECT_DISCRIMINATOR = discriminator("account", "Project");
const CREATE_ADMIN_TOKEN_ACCOUNT = discriminator("global", "create_admin_token_account");
const CLAIM_V2 = discriminator("global", "claim_v2");

function decodeReferralAccount(data: Uint8Array): ReferralAccount {
  const bytes = Buffer.from(data);
  if (
    bytes.length < 72 ||
    !bytes.subarray(0, REFERRAL_ACCOUNT_DISCRIMINATOR.length).equals(REFERRAL_ACCOUNT_DISCRIMINATOR)
  ) {
    throw new Error("Invalid Jupiter referral account");
  }
  return {
    partner: new PublicKey(bytes.subarray(8, 40)),
    project: new PublicKey(bytes.subarray(40, 72)),
  };
}

function decodeProject(data: Uint8Array): Project {
  const bytes = Buffer.from(data);
  if (
    bytes.length < 72 ||
    !bytes.subarray(0, PROJECT_DISCRIMINATOR.length).equals(PROJECT_DISCRIMINATOR)
  ) {
    throw new Error("Invalid Jupiter referral project");
  }
  return {
    base: new PublicKey(bytes.subarray(8, 40)),
    admin: new PublicKey(bytes.subarray(40, 72)),
  };
}

function createAdminTokenAccountInstruction(input: {
  project: PublicKey;
  projectAuthority: PublicKey;
  admin: PublicKey;
  projectAdminTokenAccount: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: REFERRAL_PROGRAM_ID,
    keys: [
      { pubkey: input.project, isSigner: false, isWritable: false },
      { pubkey: input.projectAuthority, isSigner: false, isWritable: true },
      { pubkey: input.admin, isSigner: false, isWritable: false },
      { pubkey: input.projectAdminTokenAccount, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: input.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CREATE_ADMIN_TOKEN_ACCOUNT,
  });
}

function claimV2Instruction(input: {
  payer: PublicKey;
  project: PublicKey;
  admin: PublicKey;
  projectAdminTokenAccount: PublicKey;
  referralAccount: PublicKey;
  referralTokenAccount: PublicKey;
  partner: PublicKey;
  partnerTokenAccount: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: REFERRAL_PROGRAM_ID,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.project, isSigner: false, isWritable: false },
      { pubkey: input.admin, isSigner: false, isWritable: false },
      { pubkey: input.projectAdminTokenAccount, isSigner: false, isWritable: true },
      { pubkey: input.referralAccount, isSigner: false, isWritable: false },
      { pubkey: input.referralTokenAccount, isSigner: false, isWritable: true },
      { pubkey: input.partner, isSigner: false, isWritable: false },
      { pubkey: input.partnerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: input.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CLAIM_V2,
  });
}

export class ReferralProvider {
  constructor(private readonly connection: Connection) {}

  async getReferralTokenAccountsV2(referralAccountAddress: string): Promise<{
    tokenAccounts: ReferralTokenAccount[];
    token2022Accounts: ReferralTokenAccount[];
  }> {
    const owner = new PublicKey(referralAccountAddress);
    const read = async (programId: PublicKey): Promise<ReferralTokenAccount[]> => {
      const result = await this.connection.getTokenAccountsByOwner(owner, { programId });
      return result.value.map(({ pubkey, account }) => ({
        pubkey,
        account: unpackAccount(pubkey, account, programId),
      }));
    };
    const [tokenAccounts, token2022Accounts] = await Promise.all([
      read(TOKEN_PROGRAM_ID),
      read(TOKEN_2022_PROGRAM_ID),
    ]);
    return { tokenAccounts, token2022Accounts };
  }

  async initializeReferralTokenAccountV2(input: {
    payerPubKey: PublicKey;
    referralAccountPubKey: PublicKey;
    mint: PublicKey;
  }): Promise<{ tx: Transaction; tokenAccount: PublicKey }> {
    const mintInfo = await this.connection.getAccountInfo(input.mint, "confirmed");
    if (!mintInfo) throw new Error("Invalid mint");
    const tokenProgram = mintInfo.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error("Invalid mint owner");
    }
    const tokenAccount = await getAssociatedTokenAddress(
      input.mint,
      input.referralAccountPubKey,
      true,
      tokenProgram,
    );
    return {
      tx: new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          input.payerPubKey,
          tokenAccount,
          input.referralAccountPubKey,
          input.mint,
          tokenProgram,
        ),
      ),
      tokenAccount,
    };
  }

  async claimAllV2(input: {
    payerPubKey: PublicKey;
    referralAccountPubKey: PublicKey;
  }): Promise<VersionedTransaction[]> {
    const referralInfo = await this.connection.getAccountInfo(
      input.referralAccountPubKey,
      "confirmed",
    );
    if (!referralInfo || !referralInfo.owner.equals(REFERRAL_PROGRAM_ID)) {
      throw new Error("Invalid Jupiter referral account");
    }
    const referral = decodeReferralAccount(referralInfo.data);
    const projectInfo = await this.connection.getAccountInfo(referral.project, "confirmed");
    if (!projectInfo || !projectInfo.owner.equals(REFERRAL_PROGRAM_ID)) {
      throw new Error("Invalid Jupiter referral project");
    }
    const project = decodeProject(projectInfo.data);
    const projectAuthority = new PublicKey(
      (
        await getProgramDerivedAddress({
          seeds: [Buffer.from("project_authority"), project.base.toBuffer()],
          programAddress: REFERRAL_PROGRAM_ID.toBase58(),
        })
      )[0],
    );
    const { tokenAccounts, token2022Accounts } = await this.getReferralTokenAccountsV2(
      input.referralAccountPubKey.toBase58(),
    );
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const lookupTable = await this.connection
      .getAddressLookupTable(REFERRAL_LOOKUP_TABLE)
      .then(({ value }) => value)
      .catch(() => null);
    const transactions: VersionedTransaction[] = [];

    for (const [accounts, tokenProgram] of [
      [tokenAccounts, TOKEN_PROGRAM_ID],
      [token2022Accounts, TOKEN_2022_PROGRAM_ID],
    ] as const) {
      let batch: TransactionInstruction[] = [];
      let claimCount = 0;
      const flush = () => {
        if (batch.length === 0) return;
        transactions.push(
          new VersionedTransaction(
            new TransactionMessage({
              payerKey: input.payerPubKey,
              recentBlockhash: String(latestBlockhash.blockhash),
              instructions: batch,
            }).compileToV0Message(lookupTable ? [lookupTable] : []),
          ),
        );
        batch = [];
        claimCount = 0;
      };

      for (const token of accounts) {
        if (token.account.amount <= 0n || token.account.state !== 1) continue;
        const mint = token.account.mint;
        const partnerTokenAccount = await getAssociatedTokenAddress(
          mint,
          referral.partner,
          true,
          tokenProgram,
        );
        const projectAdminTokenAccount = await getAssociatedTokenAddress(
          mint,
          project.admin,
          true,
          tokenProgram,
        );
        batch.push(
          createAssociatedTokenAccountIdempotentInstruction(
            input.payerPubKey,
            partnerTokenAccount,
            referral.partner,
            mint,
            tokenProgram,
          ),
          createAdminTokenAccountInstruction({
            project: referral.project,
            projectAuthority,
            admin: project.admin,
            projectAdminTokenAccount,
            mint,
            tokenProgram,
          }),
          claimV2Instruction({
            payer: input.payerPubKey,
            project: referral.project,
            admin: project.admin,
            projectAdminTokenAccount,
            referralAccount: input.referralAccountPubKey,
            referralTokenAccount: token.pubkey,
            partner: referral.partner,
            partnerTokenAccount,
            mint,
            tokenProgram,
          }),
        );
        claimCount += 1;
        if (claimCount === CLAIMS_PER_TRANSACTION) flush();
      }
      flush();
    }
    return transactions;
  }
}
