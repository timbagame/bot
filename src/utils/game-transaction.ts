import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  partiallySignTransactionWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Blockhash,
  type FullySignedTransaction,
  type Instruction,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import type { TransactionInstruction } from "#solana";

export type GameTransactionBlockhash = Readonly<{
  blockhash: string;
  lastValidBlockHeight: number;
}>;

function accountRole(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner) {
    return isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  }
  return isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

/** Converts the temporary class-shaped instruction surface at the edge only. */
export function toKitInstruction(instruction: TransactionInstruction): Instruction {
  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts: instruction.keys.map((account) => ({
      address: address(account.pubkey.toBase58()),
      role: accountRole(account.isSigner, account.isWritable),
    })),
    data: Uint8Array.from(instruction.data),
  };
}

export async function buildOracleSignableGameTransaction(options: {
  instructions: readonly TransactionInstruction[];
  creator: TransactionPartialSigner;
  blockhash: GameTransactionBlockhash;
}): Promise<{ txBase64: string; messageBytes: Uint8Array }> {
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (value) => setTransactionMessageFeePayer(options.creator.address, value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: options.blockhash.blockhash as Blockhash,
          lastValidBlockHeight: BigInt(options.blockhash.lastValidBlockHeight),
        },
        value,
      ),
    (value) =>
      appendTransactionMessageInstructions(options.instructions.map(toKitInstruction), value),
  );

  const transaction = compileTransaction(message);
  const partiallySigned = await partiallySignTransactionWithSigners([options.creator], transaction);

  return {
    txBase64: getBase64EncodedWireTransaction(partiallySigned),
    messageBytes: Uint8Array.from(partiallySigned.messageBytes),
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function decodeGameTransaction(txBase64: string): Transaction {
  return getTransactionDecoder().decode(getBase64Encoder().encode(txBase64));
}

export async function finalizeOracleSignedGameTransaction(options: {
  oracleSignedBase64: string;
  expectedMessageBytes: Uint8Array;
  creator: TransactionPartialSigner;
}): Promise<Transaction & FullySignedTransaction> {
  const oracleSigned = decodeGameTransaction(options.oracleSignedBase64);
  if (!equalBytes(Uint8Array.from(oracleSigned.messageBytes), options.expectedMessageBytes)) {
    throw new Error("Oracle changed the game transaction message");
  }

  const fullySigned = await partiallySignTransactionWithSigners([options.creator], oracleSigned);
  assertIsFullySignedTransaction(fullySigned);
  assertIsTransactionWithinSizeLimit(fullySigned);

  for (const [signerAddress, signerSignature] of Object.entries(fullySigned.signatures)) {
    if (
      !signerSignature ||
      !(await verifySignature(
        await getPublicKeyFromAddress(address(signerAddress)),
        signerSignature,
        fullySigned.messageBytes,
      ))
    ) {
      throw new Error(`Invalid game transaction signature for ${signerAddress}`);
    }
  }

  return fullySigned;
}

/** Preserve every instruction/account byte; only replace the recent blockhash.
 * Both signatures must be regenerated and Oracle must approve the new message.
 */
export async function refreshGameTransaction(
  txBase64: string,
  blockhash: GameTransactionBlockhash,
  creator: TransactionPartialSigner,
): Promise<{ txBase64: string; messageBytes: Uint8Array }> {
  const original = decodeGameTransaction(txBase64);
  const message = getCompiledTransactionMessageDecoder().decode(original.messageBytes);
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...message,
    lifetimeToken: blockhash.blockhash as Blockhash,
  });
  const transaction = {
    messageBytes,
    signatures: Object.fromEntries(Object.keys(original.signatures).map((key) => [key, null])),
  } as Transaction;
  const signed = await partiallySignTransactionWithSigners([creator], transaction);
  return {
    txBase64: getBase64EncodedWireTransaction(signed),
    messageBytes: Uint8Array.from(messageBytes),
  };
}
