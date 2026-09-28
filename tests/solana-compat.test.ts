import { describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  addressOnlySigner,
  toTransactionInstruction,
} from "../src/utils/solana";

describe("Transaction.from", () => {
  test("round-trips a serialized transaction and keeps the compat subclass", async () => {
    const payer = await Keypair.generate();
    const recipient = (await Keypair.generate()).publicKey;
    const original = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
    });
    original.add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 5 }),
    );
    const bytes = await original.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const decoded = Transaction.from(bytes);

    expect(decoded).toBeInstanceOf(Transaction);
    expect(decoded.feePayer?.toBase58()).toBe(payer.publicKey.toBase58());
    expect(decoded.instructions).toHaveLength(1);
    expect(decoded.instructions[0]!.keys[1]!.pubkey.toBase58()).toBe(recipient.toBase58());
  });

  test("rejects bytes that are not a transaction", () => {
    expect(() => Transaction.from(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("toTransactionInstruction", () => {
  test("maps Kit account roles onto signer and writable flags", () => {
    const address = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed)).toBase58();
    const readonly = address(1);
    const writable = address(2);
    const signer = address(3);
    const writableSigner = address(4);
    const program = address(5);

    const instruction = toTransactionInstruction({
      programAddress: program,
      accounts: [
        { address: readonly, role: 0 },
        { address: writable, role: 1 },
        { address: signer, role: 2 },
        { address: writableSigner, role: 3 },
      ],
      data: new Uint8Array([9, 8, 7]),
    });

    expect(instruction.programId.toBase58()).toBe(program);
    expect(
      instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    ).toEqual([
      [readonly, false, false],
      [writable, false, true],
      [signer, true, false],
      [writableSigner, true, true],
    ]);
    expect(Array.from(instruction.data)).toEqual([9, 8, 7]);
  });

  test("defaults to no accounts and empty data", () => {
    const program = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

    const instruction = toTransactionInstruction({ programAddress: program as any });

    expect(instruction.keys).toEqual([]);
    expect(instruction.data.length).toBe(0);
  });
});

describe("addressOnlySigner", () => {
  test("exposes the address but refuses to sign", async () => {
    const key = new PublicKey(new Uint8Array(32).fill(3));

    const signer = addressOnlySigner(key);

    expect(signer.address).toBe(key.toBase58() as any);
    await expect(signer.signTransactions()).rejects.toThrow(
      `No signing material is attached to ${key.toBase58()}`,
    );
  });
});
