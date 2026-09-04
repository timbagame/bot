import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import {
  PublicKey as Web3PublicKey,
  Transaction as Web3Transaction,
  TransactionInstruction as Web3TransactionInstruction,
  TransactionMessage as Web3TransactionMessage,
  type PublicKeyInitData,
  type Transaction as KitTransaction,
} from "@solana/web3.js";
import { signatureBytes, type Address, type Blockhash, type ReadonlyUint8Array } from "@solana/kit";
import type { Instruction } from "@solana/kit";

declare module "@solana/web3.js" {
  interface PublicKey {
    toBuffer(): Buffer;
  }
}

export {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  SendTransactionError,
  SolanaJSONRPCError,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  clusterApiUrl,
  sendAndConfirmRawTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
export type {
  AccountInfo,
  Commitment,
  ConnectionConfig,
  SendOptions,
  TokenBalance,
  VersionedTransactionResponse,
} from "@solana/web3.js";

const PDA_MARKER = Buffer.from("ProgramDerivedAddress");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Small compatibility value object used while Bot's domain model moves from
 * class-shaped public keys to Kit `Address` strings. All RPC and program work
 * is still performed by Kit-backed web3.js v3 and generated Kit clients.
 */
export type PublicKey = Web3PublicKey;

type PublicKeyConstructor = typeof Web3PublicKey & {
  new (value: PublicKeyInitData): Web3PublicKey;
  createProgramAddressSync(
    seeds: Array<Uint8Array | ReadonlyUint8Array>,
    programId: Web3PublicKey,
  ): Web3PublicKey;
  findProgramAddressSync(
    seeds: Array<Uint8Array | ReadonlyUint8Array>,
    programId: Web3PublicKey,
  ): [Web3PublicKey, number];
};

Web3PublicKey.prototype.toBuffer = function toBuffer(): Buffer {
  return Buffer.from(this.toBytes());
};

const createProgramAddressSync = (
  seeds: Array<Uint8Array | ReadonlyUint8Array>,
  programId: Web3PublicKey,
): Web3PublicKey => {
  if (seeds.length > 16 || seeds.some((seed) => seed.length > 32)) {
    throw new TypeError("Invalid program-derived-address seeds");
  }
  const digest = createHash("sha256")
    .update(
      Buffer.concat([
        ...seeds.map((seed) => Buffer.from(seed)),
        Buffer.from(programId.toBytes()),
        PDA_MARKER,
      ]),
    )
    .digest();
  if (Web3PublicKey.isOnCurve(digest)) {
    throw new Error("Invalid seeds, address must fall off the curve");
  }
  return new Web3PublicKey(digest);
};

const findProgramAddressSync = (
  seeds: Array<Uint8Array | ReadonlyUint8Array>,
  programId: Web3PublicKey,
): [Web3PublicKey, number] => {
  for (let bump = 255; bump >= 0; bump -= 1) {
    try {
      return [createProgramAddressSync([...seeds, Uint8Array.of(bump)], programId), bump];
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("fall off the curve")) {
        throw error;
      }
    }
  }
  throw new Error("Unable to derive program address");
};

Object.assign(Web3PublicKey, { createProgramAddressSync, findProgramAddressSync });
export const PublicKey = Web3PublicKey as PublicKeyConstructor;

export class Transaction extends Web3Transaction {
  constructor(
    options?: ConstructorParameters<typeof Web3Transaction>[0] | Record<string, unknown>,
  ) {
    super(options as ConstructorParameters<typeof Web3Transaction>[0]);
  }

  static override from(buffer: Uint8Array | number[]): Transaction {
    const transaction = Web3Transaction.from(buffer);
    Object.setPrototypeOf(transaction, Transaction.prototype);
    return transaction as Transaction;
  }
}

export class TransactionMessage extends Web3TransactionMessage {
  constructor(options: {
    payerKey: Web3PublicKey;
    instructions: Web3TransactionInstruction[];
    recentBlockhash: string;
    transactionConfig?: ConstructorParameters<
      typeof Web3TransactionMessage
    >[0]["transactionConfig"];
  }) {
    super(options as ConstructorParameters<typeof Web3TransactionMessage>[0]);
  }
}

type SignableMessage = Readonly<{ content: ReadonlyUint8Array }>;
type SignableTransaction = Readonly<{ messageBytes: ReadonlyUint8Array }>;

/** Synchronous key material with Kit-compatible asynchronous signing methods. */
export class Keypair {
  readonly publicKey: PublicKey;
  readonly address: Address;
  readonly secretKey: Uint8Array;
  readonly #privateKey: ReturnType<typeof createPrivateKey>;

  private constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 64) throw new Error("bad secret key size");
    this.secretKey = Uint8Array.from(secretKey);
    this.#privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretKey.subarray(0, 32))]),
      format: "der",
      type: "pkcs8",
    });
    const derivedPublicKey = createPublicKey(this.#privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    if (!Buffer.from(derivedPublicKey).equals(Buffer.from(secretKey.subarray(32)))) {
      throw new Error("provided secretKey is invalid");
    }
    this.publicKey = new PublicKey(derivedPublicKey);
    this.address = this.publicKey.toBase58();
  }

  static generate(): Keypair {
    const seed = randomBytes(32);
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    return new Keypair(new Uint8Array(Buffer.concat([seed, publicKey])));
  }

  static fromSeed(seed: Uint8Array): Keypair {
    if (seed.length !== 32) throw new Error("bad seed size");
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    return new Keypair(new Uint8Array(Buffer.concat([Buffer.from(seed), publicKey])));
  }

  static fromSecretKey(secretKey: Uint8Array): Keypair {
    return new Keypair(secretKey);
  }

  readonly signMessages = async (messages: readonly SignableMessage[]) =>
    messages.map(({ content }) => ({
      [this.address]: signatureBytes(sign(null, Buffer.from(content), this.#privateKey)),
    }));

  readonly signTransactions = async (transactions: readonly SignableTransaction[]) =>
    transactions.map(({ messageBytes }) => ({
      [this.address]: signatureBytes(sign(null, Buffer.from(messageBytes), this.#privateKey)),
    }));
}

export type Signer = Keypair;
export type TransactionLike = KitTransaction;
export const asBlockhash = (value: string): Blockhash => value as Blockhash;

/** Convert a Kit/Codama instruction to the temporary web3.js v3 transaction surface. */
export function toTransactionInstruction(instruction: Instruction): Web3TransactionInstruction {
  const accounts = instruction.accounts ?? [];
  return new Web3TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.role === 2 || account.role === 3,
      isWritable: account.role === 1 || account.role === 3,
    })),
    data: instruction.data ? Uint8Array.from(instruction.data) : new Uint8Array(),
  });
}

/** A signer-shaped account meta for generated instruction builders. */
export function addressOnlySigner(publicKey: PublicKey): {
  readonly address: Address;
  readonly signTransactions: () => Promise<never>;
} {
  return {
    address: publicKey.toBase58(),
    signTransactions: async () => {
      throw new Error(`No signing material is attached to ${publicKey.toBase58()}`);
    },
  };
}
