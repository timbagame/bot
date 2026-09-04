import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "#token";
import { Connection, PublicKey } from "#solana";

import { PDAManager } from "../utils/pda";

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAM_ACCOUNT_TAG = 2;

type GameTokenAccount = {
  publicKey: PublicKey;
  account: { tokenMint: PublicKey };
};

type TimbaProgram = {
  programId: PublicKey;
  account?: { gameToken?: { all: () => Promise<GameTokenAccount[]> } };
};

const getProgramDataAddress = (data: Buffer): PublicKey => {
  if (data.length < 36 || data.readUInt32LE(0) !== PROGRAM_ACCOUNT_TAG) {
    throw new Error("Program account has an invalid upgradeable-loader layout");
  }
  return new PublicKey(data.subarray(4, 36));
};

export async function getContractCapitalLamports(
  connection: Connection,
  program: TimbaProgram,
  policyMints: readonly string[],
  includeGameTokenAccounts = false,
): Promise<bigint> {
  const programInfo = await connection.getAccountInfo(program.programId, "confirmed");
  if (!programInfo || !programInfo.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error("Unable to verify the Timba program account");
  }

  const expectedOwners = new Map<
    string,
    { address: PublicKey; owner: PublicKey; required: boolean }
  >();
  const add = (address: PublicKey, owner: PublicKey, required = true) =>
    expectedOwners.set(address.toBase58(), { address, owner, required });

  add(program.programId, UPGRADEABLE_LOADER);
  add(getProgramDataAddress(Buffer.from(programInfo.data)), UPGRADEABLE_LOADER);
  add(PDAManager.getOraclePDA(program.programId), program.programId);

  const configuredMints = new Map<string, PublicKey>();
  if (includeGameTokenAccounts) {
    const loader = program.account?.gameToken;
    if (!loader) throw new Error("The v0.2.0 program client cannot load GameToken accounts");
    for (const gameToken of await loader.all()) {
      configuredMints.set(gameToken.account.tokenMint.toBase58(), gameToken.account.tokenMint);
      add(gameToken.publicKey, program.programId);
    }
  } else {
    for (const mintAddress of policyMints) {
      configuredMints.set(mintAddress, new PublicKey(mintAddress));
    }
  }

  for (const mint of configuredMints.values()) {
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), mint.toBuffer()],
      program.programId,
    );
    add(
      getAssociatedTokenAddressSync(mint, vault, true, TOKEN_PROGRAM_ID),
      TOKEN_PROGRAM_ID,
      includeGameTokenAccounts,
    );
  }

  const targets = [...expectedOwners.values()];
  const accounts = await connection.getMultipleAccountsInfo(
    targets.map(({ address }) => address),
    "confirmed",
  );

  return accounts.reduce((total, account, index) => {
    const expected = targets[index];
    if (!expected) {
      throw new Error(`Unable to verify contract account ${index}`);
    }
    if (!account && !expected.required) {
      return total;
    }
    if (!account || !account.owner.equals(expected.owner)) {
      throw new Error(`Unable to verify contract account ${expected?.address.toBase58() ?? index}`);
    }
    return total + BigInt(account.lamports);
  }, 0n);
}
