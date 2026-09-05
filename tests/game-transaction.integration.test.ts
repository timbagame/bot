import { describe, expect, test } from "bun:test";
import {
  address,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  partiallySignTransactionWithSigners,
  verifySignature,
} from "@solana/kit";
import { Keypair, PublicKey, TransactionInstruction } from "#solana";
import {
  buildOracleSignableGameTransaction,
  decodeGameTransaction,
  finalizeOracleSignedGameTransaction,
} from "../src/utils/game-transaction";
import { WalletManager } from "../src/utils/wallet";

const MNEMONIC = "test test test test test test test test test test test junk";
describe("Kit game transaction boundary", () => {
  test("preserves both signatures and submits the exact verified wire transaction", async () => {
    const creator = await Keypair.generate();
    const oracle = await Keypair.generate();
    const programAddress = address("BPFLoader1111111111111111111111111111111111");
    const prepared = await buildOracleSignableGameTransaction({
      instructions: [
        new TransactionInstruction({
          programId: new PublicKey(programAddress),
          keys: [
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: oracle.publicKey, isSigner: true, isWritable: false },
          ],
          data: Uint8Array.of(1, 2, 3),
        }),
      ],
      creator,
      blockhash: {
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 42,
      },
    });

    const decodedByOracle = decodeGameTransaction(prepared.txBase64);
    const signedByOracle = await partiallySignTransactionWithSigners([oracle], decodedByOracle);
    const finalized = await finalizeOracleSignedGameTransaction({
      oracleSignedBase64: getBase64EncodedWireTransaction(signedByOracle),
      expectedMessageBytes: prepared.messageBytes,
      creator,
    });
    const expectedWire = getBase64EncodedWireTransaction(finalized);
    const expectedSignature = getSignatureFromTransaction(finalized);
    let submittedWire: string | undefined;

    const sendGameTransaction = async (_rpcUrl: string, txBase64: string) => {
      submittedWire = txBase64;
      const submitted = decodeGameTransaction(submittedWire);
      for (const [signerAddress, signature] of Object.entries(submitted.signatures)) {
        expect(signature).not.toBeNull();
        expect(
          await verifySignature(
            await getPublicKeyFromAddress(address(signerAddress)),
            signature!,
            submitted.messageBytes,
          ),
        ).toBe(true);
      }
      return expectedSignature;
    };

    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: { rpcEndpoint: "http://rpc.test" } as any,
      tokenDb: {} as any,
      sendGameTransaction,
    });
    const signature = await wallet.sendFullySignedGameTransaction(finalized, {
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 42,
    });

    expect(signature).toBe(expectedSignature);
    expect(submittedWire).toBe(expectedWire);
  });

  test("rejects an Oracle response that changes the transaction message", async () => {
    const creator = await Keypair.generate();
    const oracle = await Keypair.generate();
    const prepared = await buildOracleSignableGameTransaction({
      instructions: [
        new TransactionInstruction({
          programId: new PublicKey("BPFLoader1111111111111111111111111111111111"),
          keys: [
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: oracle.publicKey, isSigner: true, isWritable: false },
          ],
          data: Uint8Array.of(1),
        }),
      ],
      creator,
      blockhash: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 },
    });
    const changed = await buildOracleSignableGameTransaction({
      instructions: [
        new TransactionInstruction({
          programId: new PublicKey("BPFLoader1111111111111111111111111111111111"),
          keys: [
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: oracle.publicKey, isSigner: true, isWritable: false },
          ],
          data: Uint8Array.of(2),
        }),
      ],
      creator,
      blockhash: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 },
    });
    const signedChanged = await partiallySignTransactionWithSigners(
      [oracle],
      decodeGameTransaction(changed.txBase64),
    );

    await expect(
      finalizeOracleSignedGameTransaction({
        oracleSignedBase64: getBase64EncodedWireTransaction(signedChanged),
        expectedMessageBytes: prepared.messageBytes,
        creator,
      }),
    ).rejects.toThrow("Oracle changed the game transaction message");
  });
});
