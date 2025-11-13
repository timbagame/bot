import { describe, expect, test } from "bun:test";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { AddressLookupTableAccount } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

function createLookupTableAccount(): AddressLookupTableAccount {
  const addresses = [Keypair.generate().publicKey];
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses,
    },
  });
}

function buildVersionedTxBase64(
  table: AddressLookupTableAccount,
  programIdOverride: PublicKey = Keypair.generate().publicKey
): string {
  const payer = Keypair.generate();
  const lookupKey = table.state.addresses[0]!;
  const instruction = new TransactionInstruction({
    programId: programIdOverride,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: lookupKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.alloc(0),
  });

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: payer.publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message([table]);

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

describe("SwapManager Jupiter instruction extraction", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  test("errors when an address lookup table is unavailable", async () => {
    const lookupTable = createLookupTableAccount();
    const base64 = buildVersionedTxBase64(lookupTable);

    const connection: Partial<Connection> = {
      async getAddressLookupTable() {
        return { value: null } as any;
      },
      async getLatestBlockhash() {
        return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 } as any;
      },
    };

    const wallet = WalletManager.createForTest(mnemonic, {
      connection: connection as Connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    const manager = new SwapManager(connection as Connection, wallet);

    await expect((manager as any).extractJupiterInstructions(base64)).rejects.toThrow(
      `Lookup table ${lookupTable.key.toBase58()} not found`
    );
  });

  test("preserves isSigner/isWritable metadata when reconstructing instructions", async () => {
    const lookupTable = createLookupTableAccount();
    const base64 = buildVersionedTxBase64(lookupTable);

    const connection: Partial<Connection> = {
      async getAddressLookupTable(pubkey: PublicKey) {
        if (pubkey.equals(lookupTable.key)) {
          return { value: lookupTable } as any;
        }
        return { value: null } as any;
      },
      async getLatestBlockhash() {
        return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 } as any;
      },
    };

    const wallet = WalletManager.createForTest(mnemonic, {
      connection: connection as Connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    const manager = new SwapManager(connection as Connection, wallet);

    const { instructions } = await (manager as any).extractJupiterInstructions(base64);

    expect(instructions.length).toBe(1);
    const keys = instructions[0].keys;
    expect(keys[0].isSigner).toBe(true);
    expect(keys[0].isWritable).toBe(true);
    expect(keys[1].isSigner).toBe(false);
    expect(keys[1].isWritable).toBe(true);
  });

  test("allows system program instructions in the serialized swap", async () => {
    const lookupTable = createLookupTableAccount();
    const base64 = buildVersionedTxBase64(
      lookupTable,
      SystemProgram.programId
    );

    const connection: Partial<Connection> = {
      async getAddressLookupTable(_pubkey: PublicKey) {
        return { value: lookupTable } as any;
      },
      async getLatestBlockhash() {
        return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 } as any;
      },
    };

    const wallet = WalletManager.createForTest(mnemonic, {
      connection: connection as Connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    const manager = new SwapManager(connection as Connection, wallet);

    const { instructions } = await (manager as any).extractJupiterInstructions(
      base64
    );

    expect(instructions).toHaveLength(1);
    expect(
      instructions[0]?.programId.equals(SystemProgram.programId)
    ).toBe(true);
  });
});
