import { describe, expect, test } from "bun:test";
import {
  JOIN_GAME_DISCRIMINATOR as JOIN_GAME_DISCRIMINATOR_V020,
  getOracleEncoder as getOracleEncoderV020,
  TIMBA_PROGRAM_ADDRESS as TIMBA_PROGRAM_ADDRESS_V020,
} from "@timbagame/protocol/contracts/v0.2.0/kit";
import {
  JOIN_GAME_DISCRIMINATOR as JOIN_GAME_DISCRIMINATOR_V030,
  getOracleEncoder as getOracleEncoderV030,
  TIMBA_PROGRAM_ADDRESS as TIMBA_PROGRAM_ADDRESS_V030,
} from "@timbagame/protocol/contracts/v0.3.0/kit";
import { Keypair, PublicKey, type Connection } from "#solana";
import { contractVersion } from "../src/utils/contract-idl";
import { createTimbaProgram } from "../src/utils/timba-program";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "#token";

const publicKey = async () => (await Keypair.generate()).publicKey;

describe(`Timba ${contractVersion} generated client adapter`, () => {
  test("builds join_game with the selected generated client and account layout", async () => {
    const version030 = contractVersion === "0.3.0";
    const game = await publicKey();
    const player = await publicKey();
    const oracleOperator = await publicKey();
    const tokenMint = await publicKey();
    const gameVault = await publicKey();
    const gameVaultTokenAccount = await publicKey();
    const gameToken = await publicKey();
    const gameTokenAccount = await publicKey();
    const playerTokenAccount = await publicKey();
    const oracle = await publicKey();
    const program = createTimbaProgram({} as Connection);

    const instruction = await program.methods
      .joinGame()
      .accounts({
        game,
        player,
        oracleOperator,
        playerTokenAccount,
        oracle,
        ...(version030
          ? {
              gameVaultCtx: {
                tokenMint,
                gameVault,
                gameVaultTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              },
            }
          : {
              gameTokenCtx: {
                tokenMint,
                gameToken,
                gameVault,
                gameTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              },
            }),
      })
      .instruction();

    expect(program.programId.toBase58()).toBe(
      version030 ? TIMBA_PROGRAM_ADDRESS_V030 : TIMBA_PROGRAM_ADDRESS_V020,
    );
    expect([...instruction.data]).toEqual([
      ...(version030 ? JOIN_GAME_DISCRIMINATOR_V030 : JOIN_GAME_DISCRIMINATOR_V020),
    ]);
    expect(instruction.keys.map(({ pubkey }) => pubkey.toBase58())).toEqual(
      (version030
        ? [
            game,
            player,
            oracleOperator,
            tokenMint,
            gameVault,
            gameVaultTokenAccount,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
            playerTokenAccount,
            oracle,
          ]
        : [
            game,
            player,
            oracleOperator,
            tokenMint,
            gameToken,
            gameVault,
            gameTokenAccount,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
            playerTokenAccount,
            oracle,
          ]
      ).map((key) => key.toBase58()),
    );
    expect(instruction.keys[1]).toMatchObject({ isSigner: true, isWritable: true });
    expect(instruction.keys[2]).toMatchObject({ isSigner: true, isWritable: false });
  });

  test("validates account ownership and discriminator before decoding", async () => {
    const version030 = contractVersion === "0.3.0";
    const programId = new PublicKey(
      version030 ? TIMBA_PROGRAM_ADDRESS_V030 : TIMBA_PROGRAM_ADDRESS_V020,
    );
    const address = await publicKey();
    const operator = await publicKey();
    const encoded = (version030 ? getOracleEncoderV030() : getOracleEncoderV020()).encode({
      operator: operator.toBase58(),
      feePercentage: 1,
      oracleBufferTime: 60n,
      maxTickets: 100,
      maxTimeout: 3_600n,
      minTimeout: 60n,
    });
    let owner = programId;
    let data: Uint8Array = Uint8Array.from(encoded);
    const connection = {
      getAccountInfo: async () => ({
        data,
        executable: false,
        lamports: 1n,
        owner,
        rentEpoch: 0n,
      }),
    } as unknown as Connection;
    const program = createTimbaProgram(connection);

    const oracle = await program.account.oracle.fetch(address);
    expect(oracle.operator.toBase58()).toBe(operator.toBase58());
    expect(oracle.minTimeout).toBe(60n);

    owner = await publicKey();
    await expect(program.account.oracle.fetch(address)).rejects.toThrow("is not owned");

    owner = programId;
    data = Uint8Array.from(encoded);
    data[0] = data[0]! ^ 0xff;
    await expect(program.account.oracle.fetch(address)).rejects.toThrow("discriminator");
  });
});
