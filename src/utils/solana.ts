import {
  Keypair,
  PublicKey as Web3PublicKey,
  Transaction as Web3Transaction,
  TransactionInstruction as Web3TransactionInstruction,
  TransactionMessage as Web3TransactionMessage,
  type Transaction as KitTransaction,
} from "@solana/web3.js";
import { type Address, type Blockhash } from "@solana/kit";
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

/**
 * Small compatibility value object used while Bot's domain model moves from
 * class-shaped public keys to Kit `Address` strings. All RPC and program work
 * is still performed by Kit-backed web3.js v3 and generated Kit clients.
 */
export type PublicKey = Web3PublicKey;

Web3PublicKey.prototype.toBuffer = function toBuffer(): Buffer {
  return Buffer.from(this.toBytes());
};
export const PublicKey = Web3PublicKey;

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

export { Keypair };

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
