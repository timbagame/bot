import { describe, expect, mock, test } from "bun:test";
import * as v020 from "@timbagame/protocol/contracts/v0.2.0/kit";
import * as v030 from "@timbagame/protocol/contracts/v0.3.0/kit";
import { Keypair, PublicKey, type Connection } from "#solana";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "#token";
import { contractVersion } from "../src/utils/contract-idl";
import { TimbaAccountNotFoundError, createTimbaProgram } from "../src/utils/timba-program";

const version030 = contractVersion === "0.3.0";
const kit: any = version030 ? v030 : v020;
const key = async () => (await Keypair.generate()).publicKey;

const fundsContext = async () => {
  const context = {
    tokenMint: await key(),
    gameVault: await key(),
    gameToken: await key(),
    gameTokenAccount: await key(),
    gameVaultTokenAccount: await key(),
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  };
  return {
    context,
    accounts: version030 ? { gameVaultCtx: context } : { gameTokenCtx: context },
    versionKeys: version030
      ? [context.gameVaultTokenAccount]
      : [context.gameToken, context.gameTokenAccount],
  };
};

const keyInfo = (instruction: { keys: { pubkey: PublicKey; isSigner: boolean }[] }) => ({
  all: instruction.keys.map((entry) => entry.pubkey.toBase58()),
  signers: instruction.keys
    .filter((entry) => entry.isSigner)
    .map((entry) => entry.pubkey.toBase58()),
});

describe(`Timba ${contractVersion} instruction builders`, () => {
  const program = createTimbaProgram({} as Connection);

  test("initializeGame encodes the configuration and signs as creator and oracle", async () => {
    const { accounts, context, versionKeys } = await fundsContext();
    const game = await key();
    const creator = await key();
    const oracle = await key();
    const oracleOperator = await key();
    const creatorTokenAccount = await key();
    const systemProgram = new PublicKey("11111111111111111111111111111111");

    const instruction = await program.methods
      .initializeGame(
        {
          gameType: { giveaway: {} },
          amount: "5000",
          maxTickets: 4,
          minTickets: 1,
          timeout: 3600,
          isPrivate: 1,
        },
        Array.from({ length: 32 }, (_, index) => index),
      )
      .accounts({
        ...accounts,
        game,
        creator: creator.toBase58(),
        oracle,
        oracleOperator,
        creatorTokenAccount,
        systemProgram,
      })
      .instruction();

    expect(instruction.programId.toBase58()).toBe(kit.TIMBA_PROGRAM_ADDRESS);
    expect([...instruction.data.subarray(0, 8)]).toEqual([...kit.INITIALIZE_GAME_DISCRIMINATOR]);
    const decoded = kit.getInitializeGameInstructionDataDecoder().decode(instruction.data);
    expect(decoded).toMatchObject({
      gameType: 1,
      amount: 5000n,
      maxTickets: 4,
      minTickets: 1,
      timeout: 3600n,
      isPrivate: true,
    });
    expect([...decoded.randomHash]).toEqual(Array.from({ length: 32 }, (_, index) => index));
    const { all, signers } = keyInfo(instruction);
    for (const expected of [game, oracle, context.tokenMint, context.gameVault, ...versionKeys])
      expect(all).toContain(expected.toBase58());
    expect(signers.sort()).toEqual([creator.toBase58(), oracleOperator.toBase58()].sort());
  });

  test("initializeGame encodes coinflips as game type 0 and missing amounts as zero", async () => {
    const { accounts } = await fundsContext();
    const instruction = await program.methods
      .initializeGame(
        { gameType: { coinflip: {} }, maxTickets: 2, minTickets: 2, timeout: 60n },
        new Array(32).fill(0),
      )
      .accounts({
        ...accounts,
        game: await key(),
        creator: await key(),
        oracle: await key(),
        oracleOperator: await key(),
        creatorTokenAccount: await key(),
        systemProgram: await key(),
      })
      .instruction();

    const decoded = kit.getInitializeGameInstructionDataDecoder().decode(instruction.data);
    expect(decoded).toMatchObject({ gameType: 0, amount: 0n, isPrivate: false });
  });

  test("joinGame omits the oracle signer for public games", async () => {
    const { accounts } = await fundsContext();
    const player = await key();

    const instruction = await program.methods
      .joinGame()
      .accounts({
        ...accounts,
        game: await key(),
        player,
        playerTokenAccount: await key(),
        oracle: await key(),
      })
      .instruction();

    expect(keyInfo(instruction).signers).toEqual([player.toBase58()]);
  });

  test("unjoinGame refunds the player and is signed by the authority", async () => {
    const { accounts, versionKeys } = await fundsContext();
    const player = await key();
    const authority = await key();
    const playerTokenAccount = await key();

    const instruction = await program.methods
      .unjoinGame()
      .accounts({
        ...accounts,
        game: await key(),
        player,
        authority,
        oracle: await key(),
        playerTokenAccount,
      })
      .instruction();

    expect([...instruction.data]).toEqual([...kit.UNJOIN_GAME_DISCRIMINATOR]);
    const { all, signers } = keyInfo(instruction);
    expect(all).toContain(player.toBase58());
    expect(all).toContain(playerTokenAccount.toBase58());
    for (const expected of versionKeys) expect(all).toContain(expected.toBase58());
    expect(signers).toEqual([authority.toBase58()]);
  });

  test("closeGame is signed by the creator and returns funds to their token account", async () => {
    const { accounts } = await fundsContext();
    const creator = await key();
    const creatorTokenAccount = await key();

    const instruction = await program.methods
      .closeGame()
      .accounts({
        ...accounts,
        game: await key(),
        creator,
        oracle: await key(),
        creatorTokenAccount,
      })
      .instruction();

    expect([...instruction.data]).toEqual([...kit.CLOSE_GAME_DISCRIMINATOR]);
    const { all, signers } = keyInfo(instruction);
    expect(all).toContain(creatorTokenAccount.toBase58());
    expect(signers).toEqual([creator.toBase58()]);
  });

  test("withdrawTokenFee is only available before v0.3.0", async () => {
    const { accounts, context } = await fundsContext();
    const oracleOperator = await key();
    const builder = program.methods.withdrawTokenFee().accounts({
      ...accounts,
      oracle: await key(),
      oracleOperator,
      oracleOperatorTokenAccount: await key(),
    });

    if (version030) {
      await expect(builder.instruction()).rejects.toThrow(
        "v0.3.0 transfers completion fees directly",
      );
      return;
    }
    const instruction = await builder.instruction();
    expect([...instruction.data]).toEqual([...v020.WITHDRAW_TOKEN_FEE_DISCRIMINATOR]);
    const { all, signers } = keyInfo(instruction);
    expect(all).toContain(context.gameToken.toBase58());
    expect(signers).toEqual([oracleOperator.toBase58()]);
  });

  test("rejects accounts that are not addresses", async () => {
    const { accounts } = await fundsContext();

    await expect(
      program.methods
        .closeGame()
        .accounts({ ...accounts, game: 42, creator: await key(), oracle: await key() })
        .instruction(),
    ).rejects.toThrow("Expected a Solana address, received 42");
  });

  test("accepts address-like objects", async () => {
    const { accounts } = await fundsContext();
    const creator = await key();
    const addressLike = { toBase58: () => creator.toBase58() };

    const instruction = await program.methods
      .closeGame()
      .accounts({
        ...accounts,
        game: await key(),
        creator: addressLike,
        oracle: await key(),
        creatorTokenAccount: await key(),
      })
      .instruction();

    expect(keyInfo(instruction).signers).toEqual([creator.toBase58()]);
  });
});

describe(`Timba ${contractVersion} account clients`, () => {
  const programId = new PublicKey(kit.TIMBA_PROGRAM_ADDRESS);

  const encodeGame = async () => {
    const creator = await key();
    const tokenMint = await key();
    const player = await key();
    const data = kit.getGameEncoder().encode({
      creator: creator.toBase58(),
      gameType: 1,
      ticketAmount: 10n,
      maxTickets: 5,
      minTickets: 1,
      ticketsCount: 1,
      tokenMint: tokenMint.toBase58(),
      createdAt: 1n,
      timeout: 60n,
      lastSlot: 2n,
      isPrivate: false,
      totalAmount: 10n,
      participants: [player.toBase58()],
    });
    return { data: Uint8Array.from(data), creator, tokenMint, player };
  };

  test("games are decoded with public keys and a named game type", async () => {
    const { data, creator, tokenMint, player } = await encodeGame();
    const address = await key();
    const program = createTimbaProgram({
      getAccountInfo: async () => ({ owner: programId, data }),
    } as unknown as Connection);

    const game = await program.account.game.fetch(address);

    expect(game.creator).toBeInstanceOf(PublicKey);
    expect(game.creator.toBase58()).toBe(creator.toBase58());
    expect(game.tokenMint.toBase58()).toBe(tokenMint.toBase58());
    expect(game.participants.map((entry: PublicKey) => entry.toBase58())).toEqual([
      player.toBase58(),
    ]);
    expect(game.gameType).toEqual({ giveaway: {} });
  });

  test("a missing game account raises TimbaAccountNotFoundError", async () => {
    const address = await key();
    const program = createTimbaProgram({
      getAccountInfo: async () => null,
    } as unknown as Connection);

    const error = await program.account.game.fetch(address).catch((caught) => caught);

    expect(error).toBeInstanceOf(TimbaAccountNotFoundError);
    expect(error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(error.message).toBe(`Account ${address.toBase58()} does not exist`);
    expect(await program.account.game.fetchNullable(address)).toBeNull();
  });

  test("all() filters program accounts by discriminator and decodes them", async () => {
    const { data, creator } = await encodeGame();
    const address = await key();
    const getProgramAccounts = mock(async () => [{ pubkey: address, account: { data } }]);
    const program = createTimbaProgram({ getProgramAccounts } as unknown as Connection);

    const games = await program.account.game.all();

    expect(games).toHaveLength(1);
    expect(games[0]!.publicKey).toBe(address);
    expect(games[0]!.account.creator.toBase58()).toBe(creator.toBase58());
    const [requestedProgram, config] = getProgramAccounts.mock.calls[0] as any[];
    expect(requestedProgram.toBase58()).toBe(programId.toBase58());
    expect(config.filters[0].memcmp.offset).toBe(0n);
  });

  test("GameToken accounts exist only before v0.3.0", async () => {
    const tokenMint = await key();
    const address = await key();
    const data = Uint8Array.from(
      v020.getGameTokenEncoder().encode({
        tokenMint: tokenMint.toBase58(),
        minAmount: 5n,
        feeAmount: 7n,
        bump: 1,
        vaultBump: 2,
      } as any),
    );
    const getProgramAccounts = mock(async () => [{ pubkey: address, account: { data } }]);
    const program = createTimbaProgram({
      getAccountInfo: async () => ({ owner: programId, data }),
      getProgramAccounts,
    } as unknown as Connection);

    if (version030) {
      expect(await program.account.gameToken.fetchNullable(address)).toBeNull();
      expect(await program.account.gameToken.all()).toEqual([]);
      expect(getProgramAccounts).not.toHaveBeenCalled();
      return;
    }
    const gameToken = await program.account.gameToken.fetch(address);
    expect(gameToken.tokenMint.toBase58()).toBe(tokenMint.toBase58());
    expect(gameToken.feeAmount).toBe(7n);
  });
});

describe("program event subscriptions", () => {
  test("delivers matching events with slot and signature and can be removed", async () => {
    const programId = new PublicKey(kit.TIMBA_PROGRAM_ADDRESS);
    let listener: ((logs: any, context: any) => void) | undefined;
    const removed: number[] = [];
    const program = createTimbaProgram({
      onLogs: (id: PublicKey, callback: typeof listener, commitment: string) => {
        expect(id.toBase58()).toBe(programId.toBase58());
        expect(commitment).toBe("confirmed");
        listener = callback;
        return 17;
      },
      removeOnLogsListener: async (id: number) => {
        removed.push(id);
      },
    } as unknown as Connection);
    const seen: Array<[unknown, bigint, string]> = [];

    const id = await program.addEventListener("gameCompleted", (event, slot, signature) =>
      seen.push([event, slot, signature]),
    );
    const payload = Buffer.alloc(100);
    Buffer.from([103, 26, 106, 108, 240, 191, 179, 120]).copy(payload, 0);
    payload.writeBigUInt64LE(9n, 84);
    const closed = Buffer.alloc(48);
    Buffer.from([178, 203, 179, 224, 43, 18, 209, 4]).copy(closed, 0);
    listener!(
      {
        signature: "sig",
        logs: [
          `Program ${programId.toBase58()} invoke [1]`,
          `Program data: ${closed.toString("base64")}`,
          `Program data: ${payload.toString("base64")}`,
          `Program ${programId.toBase58()} success`,
        ],
      },
      { slot: 55n },
    );
    await program.removeEventListener(id);

    expect(id).toBe(17);
    expect(seen).toHaveLength(1);
    expect((seen[0]![0] as any).feeAmount).toBe(9n);
    expect(seen[0]!.slice(1)).toEqual([55n, "sig"]);
    expect(removed).toEqual([17]);
  });
});
