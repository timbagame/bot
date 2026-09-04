import { expect, test } from "bun:test";
import { TOKEN_PROGRAM_ID } from "#token";
import { Keypair, PublicKey } from "#solana";

import { getContractCapitalLamports } from "../src/services/contract-capital";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

test("contract capital sums only verified permanent accounts", async () => {
  const programId = Keypair.generate().publicKey;
  const programData = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const programDataBytes = Buffer.alloc(36);
  programDataBytes.writeUInt32LE(2, 0);
  programData.toBuffer().copy(programDataBytes, 4);

  const connection = {
    getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes }),
    getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
      addresses.map((_, index) => ({
        lamports: (index + 1) * 100,
        owner: index < 2 ? LOADER : index === 3 ? TOKEN_PROGRAM_ID : programId,
      })),
  };
  const program = { programId };

  expect(await getContractCapitalLamports(connection as any, program, [tokenMint.toBase58()])).toBe(
    1_000n,
  );
});

test("v0.3 contract capital skips policy vaults that have not been created", async () => {
  const programId = Keypair.generate().publicKey;
  const programData = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const programDataBytes = Buffer.alloc(36);
  programDataBytes.writeUInt32LE(2, 0);
  programData.toBuffer().copy(programDataBytes, 4);

  const connection = {
    getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes }),
    getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
      addresses.map((_, index) =>
        index === addresses.length - 1
          ? null
          : {
              lamports: 100,
              owner: index < 2 ? LOADER : programId,
            },
      ),
  };

  expect(
    await getContractCapitalLamports(connection as any, { programId }, [tokenMint.toBase58()]),
  ).toBe(300n);
});

test("v0.2 contract capital discovers GameToken accounts", async () => {
  const programId = Keypair.generate().publicKey;
  const programData = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const gameToken = Keypair.generate().publicKey;
  const programDataBytes = Buffer.alloc(36);
  programDataBytes.writeUInt32LE(2, 0);
  programData.toBuffer().copy(programDataBytes, 4);

  const connection = {
    getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes }),
    getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
      addresses.map((_, index) => ({
        lamports: 100,
        owner: index < 2 ? LOADER : index === 4 ? TOKEN_PROGRAM_ID : programId,
      })),
  };
  const program = {
    programId,
    account: {
      gameToken: {
        all: async () => [{ publicKey: gameToken, account: { tokenMint } }],
      },
    },
  };

  expect(await getContractCapitalLamports(connection as any, program, [], true)).toBe(500n);
});
