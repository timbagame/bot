import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getCreateAssociatedTokenInstruction,
  getMintDecoder,
  getSyncNativeInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getCloseAccountInstruction as getCloseAccount2022Instruction,
  getCreateAssociatedTokenIdempotentInstruction as getCreateAssociatedToken2022IdempotentInstruction,
  getCreateAssociatedTokenInstruction as getCreateAssociatedToken2022Instruction,
  getMintDecoder as getMint2022Decoder,
  getSyncNativeInstruction as getSyncNative2022Instruction,
  getTokenDecoder as getToken2022Decoder,
  getTransferCheckedInstruction as getTransferChecked2022Instruction,
  type Extension,
} from "@solana-program/token-2022";
import { unwrapOption, type Address } from "@solana/kit";
import {
  PublicKey,
  TransactionInstruction,
  addressOnlySigner,
  toTransactionInstruction,
  type AccountInfo,
  type Commitment,
  type Connection,
} from "#solana";

export const TOKEN_PROGRAM_ID = new PublicKey(TOKEN_PROGRAM_ADDRESS);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);

export enum AccountState {
  Uninitialized = 0,
  Initialized = 1,
  Frozen = 2,
}

export class TokenAccountNotFoundError extends Error {}
export class TokenInvalidAccountOwnerError extends Error {}

type TokenAccountFields = {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegateOption: number;
  delegate: PublicKey;
  state: number;
  isNativeOption: number;
  isNative: bigint;
  delegatedAmount: bigint;
  closeAuthorityOption: number;
  closeAuthority: PublicKey;
};

const ZERO_KEY = new PublicKey(new Uint8Array(32));

export const AccountLayout = {
  span: 165,
  encode(value: Partial<TokenAccountFields>, target: Uint8Array): number {
    const bytes = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
    bytes.fill(0, 0, 165);
    Buffer.from((value.mint ?? ZERO_KEY).toBytes()).copy(bytes, 0);
    Buffer.from((value.owner ?? ZERO_KEY).toBytes()).copy(bytes, 32);
    bytes.writeBigUInt64LE(BigInt(value.amount ?? 0n), 64);
    bytes.writeUInt32LE(value.delegateOption ?? 0, 72);
    Buffer.from((value.delegate ?? ZERO_KEY).toBytes()).copy(bytes, 76);
    bytes.writeUInt8(value.state ?? AccountState.Uninitialized, 108);
    bytes.writeUInt32LE(value.isNativeOption ?? 0, 109);
    bytes.writeBigUInt64LE(BigInt(value.isNative ?? 0n), 113);
    bytes.writeBigUInt64LE(BigInt(value.delegatedAmount ?? 0n), 121);
    bytes.writeUInt32LE(value.closeAuthorityOption ?? 0, 129);
    Buffer.from((value.closeAuthority ?? ZERO_KEY).toBytes()).copy(bytes, 133);
    return 165;
  },
  decode(source: Uint8Array): TokenAccountFields {
    if (source.length < 165) throw new TokenAccountNotFoundError("Invalid token account size");
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    return {
      mint: new PublicKey(bytes.subarray(0, 32)),
      owner: new PublicKey(bytes.subarray(32, 64)),
      amount: bytes.readBigUInt64LE(64),
      delegateOption: bytes.readUInt32LE(72),
      delegate: new PublicKey(bytes.subarray(76, 108)),
      state: bytes.readUInt8(108),
      isNativeOption: bytes.readUInt32LE(109),
      isNative: bytes.readBigUInt64LE(113),
      delegatedAmount: bytes.readBigUInt64LE(121),
      closeAuthorityOption: bytes.readUInt32LE(129),
      closeAuthority: new PublicKey(bytes.subarray(133, 165)),
    };
  },
};

const address = (key: PublicKey): Address => key.toBase58();

function assertTokenOwner(info: AccountInfo<Uint8Array>, programId: PublicKey): void {
  if (!info.owner.equals(programId)) {
    throw new TokenInvalidAccountOwnerError(
      `Token account is owned by ${info.owner.toBase58()}, not ${programId.toBase58()}`,
    );
  }
}

export function unpackAccount(
  accountAddress: PublicKey,
  info: AccountInfo<Uint8Array>,
  programId: PublicKey = TOKEN_PROGRAM_ID,
) {
  assertTokenOwner(info, programId);
  const decoder = programId.equals(TOKEN_2022_PROGRAM_ID)
    ? getToken2022Decoder()
    : getTokenDecoder();
  const decoded = decoder.decode(Uint8Array.from(info.data));
  return {
    address: accountAddress,
    mint: new PublicKey(decoded.mint),
    owner: new PublicKey(decoded.owner),
    amount: decoded.amount,
    delegate: unwrapOption(decoded.delegate),
    state: decoded.state,
    isNative: unwrapOption(decoded.isNative),
    rentExemptReserve: unwrapOption(decoded.isNative),
    delegatedAmount: decoded.delegatedAmount,
    closeAuthority: unwrapOption(decoded.closeAuthority),
  };
}

export async function getAccount(
  connection: Connection,
  accountAddress: PublicKey,
  commitment: Commitment = "confirmed",
  programId: PublicKey = TOKEN_PROGRAM_ID,
) {
  const info = await connection.getAccountInfo(accountAddress, commitment);
  if (!info) throw new TokenAccountNotFoundError(`Token account ${accountAddress} was not found`);
  return unpackAccount(accountAddress, info, programId);
}

export function unpackMint(
  mintAddress: PublicKey,
  info: AccountInfo<Uint8Array>,
  programId: PublicKey = TOKEN_PROGRAM_ID,
) {
  assertTokenOwner(info, programId);
  const decoded: any = (
    programId.equals(TOKEN_2022_PROGRAM_ID) ? getMint2022Decoder() : getMintDecoder()
  ).decode(Uint8Array.from(info.data));
  return {
    ...decoded,
    address: mintAddress,
    mintAuthority: unwrapOption(decoded.mintAuthority),
    freezeAuthority: unwrapOption(decoded.freezeAuthority),
    extensions: decoded.extensions ? (unwrapOption(decoded.extensions) ?? []) : [],
  };
}

type MintWithExtensions = { extensions?: Extension[] };
const extension = <TKind extends Extension["__kind"]>(mint: MintWithExtensions, kind: TKind) =>
  mint.extensions?.find(
    (item): item is Extract<Extension, { __kind: TKind }> => item.__kind === kind,
  );

export const getPermanentDelegate = (mint: MintWithExtensions) =>
  extension(mint, "PermanentDelegate");
export const getTransferHook = (mint: MintWithExtensions) => extension(mint, "TransferHook");
export const getTransferFeeConfig = (mint: MintWithExtensions) =>
  extension(mint, "TransferFeeConfig");
export const getNonTransferable = (mint: MintWithExtensions) => extension(mint, "NonTransferable");
export const getDefaultAccountState = (mint: MintWithExtensions) =>
  extension(mint, "DefaultAccountState");

export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBytes())) {
    throw new TypeError("Token owner is off curve");
  }
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId,
  )[0];
}

export async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    programId,
    associatedTokenProgramId,
  );
}

function token2022(programId: PublicKey): boolean {
  return programId.equals(TOKEN_2022_PROGRAM_ID);
}

export function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const builder = token2022(programId)
    ? getCreateAssociatedToken2022Instruction
    : getCreateAssociatedTokenInstruction;
  return toTransactionInstruction(
    builder(
      {
        payer: addressOnlySigner(payer),
        ata: address(ata),
        owner: address(owner),
        mint: address(mint),
        tokenProgram: address(programId),
      } as never,
      { programAddress: address(associatedTokenProgramId) },
    ),
  );
}

export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const builder = token2022(programId)
    ? getCreateAssociatedToken2022IdempotentInstruction
    : getCreateAssociatedTokenIdempotentInstruction;
  return toTransactionInstruction(
    builder(
      {
        payer: addressOnlySigner(payer),
        ata: address(ata),
        owner: address(owner),
        mint: address(mint),
        tokenProgram: address(programId),
      } as never,
      { programAddress: address(associatedTokenProgramId) },
    ),
  );
}

export function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: number | bigint,
  decimals: number,
  _multiSigners: readonly never[] = [],
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const builder = token2022(programId)
    ? getTransferChecked2022Instruction
    : getTransferCheckedInstruction;
  return toTransactionInstruction(
    builder(
      {
        source: address(source),
        mint: address(mint),
        destination: address(destination),
        authority: addressOnlySigner(owner),
        amount: BigInt(amount),
        decimals,
      } as never,
      { programAddress: address(programId) },
    ),
  );
}

export function createSyncNativeInstruction(
  account: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const builder = token2022(programId) ? getSyncNative2022Instruction : getSyncNativeInstruction;
  return toTransactionInstruction(
    builder({ account: address(account) } as never, { programAddress: address(programId) }),
  );
}

export function createCloseAccountInstruction(
  account: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  _multiSigners: readonly never[] = [],
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const builder = token2022(programId)
    ? getCloseAccount2022Instruction
    : getCloseAccountInstruction;
  return toTransactionInstruction(
    builder(
      {
        account: address(account),
        destination: address(destination),
        owner: addressOnlySigner(owner),
      } as never,
      { programAddress: address(programId) },
    ),
  );
}
