import bs58 from "bs58";
import { getContractClient, getGameTypeName } from "@timbagame/protocol/contracts/client";
import type { Address, Decoder, Instruction } from "@solana/kit";
import {
  GAME_TOKEN_DISCRIMINATOR,
  getGameTokenDecoder,
  getWithdrawTokenFeeInstruction,
} from "@timbagame/protocol/contracts/v0.2.0/kit";
import {
  PublicKey,
  addressOnlySigner,
  toTransactionInstruction,
  type Connection,
  type TransactionInstruction,
} from "#solana";
import { contractVersion } from "./contract-idl";
import { parseProgramEventLogs } from "./program-event-parser";

type AccountRecord = Record<string, unknown>;

export class TimbaAccountNotFoundError extends Error {
  public readonly code = "ACCOUNT_NOT_FOUND" as const;

  public constructor(address: PublicKey) {
    super(`Account ${address.toBase58()} does not exist`);
    this.name = "TimbaAccountNotFoundError";
  }
}

export interface TimbaAccountClient<T = any> {
  fetch(address: PublicKey): Promise<T>;
  fetchNullable(address: PublicKey): Promise<T | null>;
  all(): Promise<Array<{ publicKey: PublicKey; account: T }>>;
}

export interface TimbaProgram {
  readonly programId: PublicKey;
  readonly provider: { readonly connection: Connection };
  readonly account: {
    readonly game: TimbaAccountClient;
    readonly oracle: TimbaAccountClient;
    readonly gameToken: TimbaAccountClient;
  };
  readonly methods: {
    initializeGame(config: AccountRecord, randomHash: readonly number[]): InstructionBuilder;
    joinGame(): InstructionBuilder;
    unjoinGame(): InstructionBuilder;
    closeGame(): InstructionBuilder;
    withdrawTokenFee(): InstructionBuilder;
  };
  addEventListener(
    eventName: string,
    handler: (event: any, slot: bigint, signature: string) => void,
  ): Promise<number>;
  removeEventListener(id: number): Promise<void>;
}

interface InstructionBuilder {
  accounts(accounts: AccountRecord): { instruction(): Promise<TransactionInstruction> };
}

const asAddress = (value: unknown): Address => {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "string") return value as Address;
  if (value && typeof value === "object" && "toBase58" in value) {
    return (value as { toBase58(): string }).toBase58() as Address;
  }
  throw new TypeError(`Expected a Solana address, received ${String(value)}`);
};

const signer = (value: unknown) => addressOnlySigner(new PublicKey(asAddress(value)));
const bigint = (value: unknown): bigint =>
  typeof value === "bigint" ? value : BigInt(String(value ?? 0));

const funds = (accounts: AccountRecord): AccountRecord =>
  (accounts["gameTokenCtx"] ?? accounts["gameVaultCtx"] ?? {}) as AccountRecord;

function instructionBuilder(build: (accounts: AccountRecord) => Instruction): InstructionBuilder {
  return {
    accounts: (accounts) => ({
      instruction: async () => toTransactionInstruction(build(accounts)),
    }),
  };
}

function normalizeGame(data: any): any {
  return {
    ...data,
    creator: new PublicKey(data.creator),
    tokenMint: new PublicKey(data.tokenMint),
    participants: data.participants.map((participant: Address) => new PublicKey(participant)),
    gameType: { [getGameTypeName(data.gameType)]: {} },
  };
}

function normalizeOracle(data: any): any {
  return { ...data, operator: new PublicKey(data.operator) };
}

function normalizeGameToken(data: any): any {
  return { ...data, tokenMint: new PublicKey(data.tokenMint) };
}

function accountClient<T>(options: {
  connection: Connection;
  programId: PublicKey;
  discriminator: Uint8Array;
  decoder: Decoder<any>;
  normalize: (data: any) => T;
  supported?: boolean;
}): TimbaAccountClient<T> {
  const decode = (data: Uint8Array): T => {
    if (
      data.length < options.discriminator.length ||
      options.discriminator.some((byte, index) => data[index] !== byte)
    ) {
      throw new Error("Account discriminator does not match the expected Timba account type");
    }
    return options.normalize(options.decoder.decode(data));
  };
  const fetchNullable = async (address: PublicKey): Promise<T | null> => {
    if (options.supported === false) return null;
    const info = await options.connection.getAccountInfo(address, "confirmed");
    if (!info) return null;
    if (!info.owner.equals(options.programId)) {
      throw new Error(`Account ${address.toBase58()} is not owned by the Timba program`);
    }
    return decode(Uint8Array.from(info.data));
  };
  return {
    fetch: async (address) => {
      const account = await fetchNullable(address);
      if (!account) throw new TimbaAccountNotFoundError(address);
      return account;
    },
    fetchNullable,
    all: async () => {
      if (options.supported === false) return [];
      const accounts = await options.connection.getProgramAccounts(options.programId, {
        commitment: "confirmed",
        withContext: false,
        filters: [{ memcmp: { offset: 0n, bytes: bs58.encode(options.discriminator) } }],
      });
      return accounts.map(({ pubkey, account }) => ({
        publicKey: pubkey,
        account: decode(Uint8Array.from(account.data)),
      }));
    },
  };
}

export function createTimbaProgram(connection: Connection): TimbaProgram {
  const version030 = contractVersion === "0.3.0";
  const client = getContractClient(contractVersion);
  const programId = new PublicKey(client.TIMBA_PROGRAM_ADDRESS);
  const programAddress = programId.toBase58() as Address;
  const gameDecoder = client.getGameDecoder();
  const oracleDecoder = client.getOracleDecoder();
  const gameDiscriminator = client.GAME_DISCRIMINATOR;
  const oracleDiscriminator = client.ORACLE_DISCRIMINATOR;

  const tokenAccounts = (context: AccountRecord) =>
    version030
      ? { gameVaultTokenAccount: asAddress(context["gameVaultTokenAccount"]) }
      : {
          gameToken: asAddress(context["gameToken"]),
          gameTokenAccount: asAddress(context["gameTokenAccount"]),
        };

  const buildInitialize = (config: AccountRecord, randomHash: readonly number[]) =>
    instructionBuilder((accounts) => {
      const context = funds(accounts);
      const input: any = {
        ...tokenAccounts(context),
        game: asAddress(accounts["game"]),
        creator: signer(accounts["creator"]),
        oracle: asAddress(accounts["oracle"]),
        oracleOperator: signer(accounts["oracleOperator"]),
        tokenMint: asAddress(context["tokenMint"]),
        gameVault: asAddress(context["gameVault"]),
        tokenProgram: asAddress(context["tokenProgram"]),
        associatedTokenProgram: asAddress(context["associatedTokenProgram"]),
        creatorTokenAccount: asAddress(accounts["creatorTokenAccount"]),
        systemProgram: asAddress(accounts["systemProgram"]),
        gameType: "coinflip" in (config["gameType"] as AccountRecord) ? 0 : 1,
        amount: bigint(config["amount"]),
        maxTickets: Number(config["maxTickets"]),
        minTickets: Number(config["minTickets"]),
        timeout: bigint(config["timeout"]),
        isPrivate: Boolean(config["isPrivate"]),
        randomHash: Uint8Array.from(randomHash),
      };
      return client.getInitializeGameInstruction(input, { programAddress });
    });

  const buildJoin = () =>
    instructionBuilder((accounts) => {
      const context = funds(accounts);
      const input: any = {
        ...tokenAccounts(context),
        game: asAddress(accounts["game"]),
        player: signer(accounts["player"]),
        tokenMint: asAddress(context["tokenMint"]),
        gameVault: asAddress(context["gameVault"]),
        tokenProgram: asAddress(context["tokenProgram"]),
        associatedTokenProgram: asAddress(context["associatedTokenProgram"]),
        playerTokenAccount: asAddress(accounts["playerTokenAccount"]),
        oracle: asAddress(accounts["oracle"]),
      };
      if (accounts["oracleOperator"]) input.oracleOperator = signer(accounts["oracleOperator"]);
      return client.getJoinGameInstruction(input, { programAddress });
    });

  const buildUnjoin = () =>
    instructionBuilder((accounts) => {
      const context = funds(accounts);
      const input: any = {
        ...tokenAccounts(context),
        game: asAddress(accounts["game"]),
        player: asAddress(accounts["player"]),
        authority: signer(accounts["authority"]),
        oracle: asAddress(accounts["oracle"]),
        tokenMint: asAddress(context["tokenMint"]),
        gameVault: asAddress(context["gameVault"]),
        tokenProgram: asAddress(context["tokenProgram"]),
        associatedTokenProgram: asAddress(context["associatedTokenProgram"]),
        playerTokenAccount: asAddress(accounts["playerTokenAccount"]),
      };
      return client.getUnjoinGameInstruction(input, { programAddress });
    });

  const buildClose = () =>
    instructionBuilder((accounts) => {
      const context = funds(accounts);
      const input: any = {
        ...tokenAccounts(context),
        game: asAddress(accounts["game"]),
        creator: signer(accounts["creator"]),
        oracle: asAddress(accounts["oracle"]),
        tokenMint: asAddress(context["tokenMint"]),
        gameVault: asAddress(context["gameVault"]),
        tokenProgram: asAddress(context["tokenProgram"]),
        associatedTokenProgram: asAddress(context["associatedTokenProgram"]),
        creatorTokenAccount: asAddress(accounts["creatorTokenAccount"]),
      };
      return client.getCloseGameInstruction(input, { programAddress });
    });

  const buildWithdraw = () =>
    instructionBuilder((accounts) => {
      if (version030) throw new Error("v0.3.0 transfers completion fees directly");
      const context = funds(accounts);
      return getWithdrawTokenFeeInstruction(
        {
          tokenMint: asAddress(context["tokenMint"]),
          gameToken: asAddress(context["gameToken"]),
          gameVault: asAddress(context["gameVault"]),
          gameTokenAccount: asAddress(context["gameTokenAccount"]),
          tokenProgram: asAddress(context["tokenProgram"]),
          associatedTokenProgram: asAddress(context["associatedTokenProgram"]),
          oracle: asAddress(accounts["oracle"]),
          oracleOperator: signer(accounts["oracleOperator"]),
          oracleOperatorTokenAccount: asAddress(accounts["oracleOperatorTokenAccount"]),
        },
        { programAddress },
      );
    });

  return {
    programId,
    provider: { connection },
    account: {
      game: accountClient({
        connection,
        programId,
        discriminator: Uint8Array.from(gameDiscriminator),
        decoder: gameDecoder,
        normalize: normalizeGame,
      }),
      oracle: accountClient({
        connection,
        programId,
        discriminator: Uint8Array.from(oracleDiscriminator),
        decoder: oracleDecoder,
        normalize: normalizeOracle,
      }),
      gameToken: accountClient({
        connection,
        programId,
        discriminator: Uint8Array.from(GAME_TOKEN_DISCRIMINATOR),
        decoder: getGameTokenDecoder(),
        normalize: normalizeGameToken,
        supported: !version030,
      }),
    },
    methods: {
      initializeGame: buildInitialize,
      joinGame: buildJoin,
      unjoinGame: buildUnjoin,
      closeGame: buildClose,
      withdrawTokenFee: buildWithdraw,
    },
    addEventListener: async (eventName, handler) =>
      connection.onLogs(
        programId,
        ({ logs, signature }, context) => {
          for (const event of parseProgramEventLogs(programId, logs)) {
            if (event.name.toLowerCase() === eventName.toLowerCase()) {
              handler(event.data, context.slot, signature);
            }
          }
        },
        "confirmed",
      ),
    removeEventListener: async (id) => connection.removeOnLogsListener(id),
  };
}
