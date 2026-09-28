import { describe, expect, test } from "bun:test";
import { TOKEN_PROGRAM_ID } from "#token";
import { Keypair, PublicKey } from "#solana";

import { getContractCapitalLamports } from "../src/services/contract-capital";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

test("contract capital sums only verified permanent accounts", async () => {
  const programId = (await Keypair.generate()).publicKey;
  const programData = (await Keypair.generate()).publicKey;
  const tokenMint = (await Keypair.generate()).publicKey;
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
  const programId = (await Keypair.generate()).publicKey;
  const programData = (await Keypair.generate()).publicKey;
  const tokenMint = (await Keypair.generate()).publicKey;
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
  const programId = (await Keypair.generate()).publicKey;
  const programData = (await Keypair.generate()).publicKey;
  const tokenMint = (await Keypair.generate()).publicKey;
  const gameToken = (await Keypair.generate()).publicKey;
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

describe("contract capital verification failures", () => {
  const setup = async () => {
    const programId = (await Keypair.generate()).publicKey;
    const programData = (await Keypair.generate()).publicKey;
    const programDataBytes = Buffer.alloc(36);
    programDataBytes.writeUInt32LE(2, 0);
    programData.toBuffer().copy(programDataBytes, 4);
    return { programId, programData, programDataBytes };
  };

  test("rejects a missing program account", async () => {
    const { programId } = await setup();
    const connection = { getAccountInfo: async () => null };

    await expect(getContractCapitalLamports(connection as any, { programId }, [])).rejects.toThrow(
      "Unable to verify the Timba program account",
    );
  });

  test("rejects a program account not owned by the upgradeable loader", async () => {
    const { programId, programDataBytes } = await setup();
    const connection = {
      getAccountInfo: async () => ({ owner: programId, data: programDataBytes }),
    };

    await expect(getContractCapitalLamports(connection as any, { programId }, [])).rejects.toThrow(
      "Unable to verify the Timba program account",
    );
  });

  test("rejects program data that is too short", async () => {
    const { programId, programDataBytes } = await setup();
    const connection = {
      getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes.subarray(0, 35) }),
    };

    await expect(getContractCapitalLamports(connection as any, { programId }, [])).rejects.toThrow(
      "invalid upgradeable-loader layout",
    );
  });

  test("rejects program data with the wrong account tag", async () => {
    const { programId, programDataBytes } = await setup();
    const data = Buffer.from(programDataBytes);
    data.writeUInt32LE(3, 0);
    const connection = { getAccountInfo: async () => ({ owner: LOADER, data }) };

    await expect(getContractCapitalLamports(connection as any, { programId }, [])).rejects.toThrow(
      "invalid upgradeable-loader layout",
    );
  });

  test("rejects a v0.2 program client without GameToken support", async () => {
    const { programId, programDataBytes } = await setup();
    const connection = {
      getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes }),
    };

    await expect(
      getContractCapitalLamports(connection as any, { programId }, [], true),
    ).rejects.toThrow("cannot load GameToken accounts");
  });

  test("names the account whose owner does not match", async () => {
    const { programId, programDataBytes } = await setup();
    const connection = {
      getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes }),
      getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
        addresses.map(() => ({ lamports: 1, owner: programId })),
    };

    // The program account (index 0) must be loader-owned; a program-owned one fails first.
    await expect(getContractCapitalLamports(connection as any, { programId }, [])).rejects.toThrow(
      `Unable to verify contract account ${programId.toBase58()}`,
    );
  });

  test("rejects a required account that does not exist", async () => {
    const { programId, programDataBytes } = await setup();
    const tokenMint = (await Keypair.generate()).publicKey;
    const gameToken = (await Keypair.generate()).publicKey;
    const connection = {
      getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes }),
      // In v0.2 mode vault ATAs are required, so a missing one is an error.
      getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
        addresses.map((_, index) =>
          index === addresses.length - 1
            ? null
            : { lamports: 1, owner: index < 2 ? LOADER : programId },
        ),
    };
    const program = {
      programId,
      account: {
        gameToken: { all: async () => [{ publicKey: gameToken, account: { tokenMint } }] },
      },
    };

    await expect(getContractCapitalLamports(connection as any, program, [], true)).rejects.toThrow(
      "Unable to verify contract account",
    );
  });

  test("rejects an RPC response with more accounts than requested", async () => {
    const { programId, programDataBytes } = await setup();
    const connection = {
      getAccountInfo: async () => ({ owner: LOADER, data: programDataBytes }),
      getMultipleAccountsInfo: async (addresses: PublicKey[]) => [
        ...addresses.map((_, index) => ({ lamports: 1, owner: index < 2 ? LOADER : programId })),
        { lamports: 1, owner: programId },
      ],
    };

    await expect(getContractCapitalLamports(connection as any, { programId }, [])).rejects.toThrow(
      "Unable to verify contract account 3",
    );
  });
});
