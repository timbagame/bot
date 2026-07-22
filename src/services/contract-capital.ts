import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import { PDAManager } from "../utils/pda";

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAM_ACCOUNT_TAG = 2;

type GameTokenAccount = {
  publicKey: PublicKey;
  account: { tokenMint: PublicKey };
};

type ProgramWithGameTokens = {
  programId: PublicKey;
  account: { gameToken: { all: () => Promise<GameTokenAccount[]> } };
};

const getProgramDataAddress = (data: Buffer): PublicKey => {
  if (data.length < 36 || data.readUInt32LE(0) !== PROGRAM_ACCOUNT_TAG) {
    throw new Error("Program account has an invalid upgradeable-loader layout");
  }
  return new PublicKey(data.subarray(4, 36));
};

export async function getContractCapitalLamports(
  connection: Connection,
  program: ProgramWithGameTokens,
): Promise<bigint> {
  const programInfo = await connection.getAccountInfo(program.programId, "confirmed");
  if (!programInfo || !programInfo.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error("Unable to verify the Timba program account");
  }

  const expectedOwners = new Map<string, { address: PublicKey; owner: PublicKey }>();
  const add = (address: PublicKey, owner: PublicKey) =>
    expectedOwners.set(address.toBase58(), { address, owner });

  add(program.programId, UPGRADEABLE_LOADER);
  add(getProgramDataAddress(programInfo.data), UPGRADEABLE_LOADER);
  add(PDAManager.getOraclePDA(program.programId), program.programId);

  for (const gameToken of await program.account.gameToken.all()) {
    const mint = gameToken.account.tokenMint;
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), mint.toBuffer()],
      program.programId,
    );
    add(gameToken.publicKey, program.programId);
    add(getAssociatedTokenAddressSync(mint, vault, true, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID);
  }

  const targets = [...expectedOwners.values()];
  const accounts = await connection.getMultipleAccountsInfo(
    targets.map(({ address }) => address),
    "confirmed",
  );

  return accounts.reduce((total, account, index) => {
    const expected = targets[index];
    if (!account || !expected || !account.owner.equals(expected.owner)) {
      throw new Error(`Unable to verify contract account ${expected?.address.toBase58() ?? index}`);
    }
    return total + BigInt(account.lamports);
  }, 0n);
}
