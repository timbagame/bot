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

  test("rejects an Oracle response carrying a forged Oracle signature", async () => {
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
          data: Uint8Array.of(9),
        }),
      ],
      creator,
      blockhash: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 },
    });
    const decoded = decodeGameTransaction(prepared.txBase64);
    const oracleAddress = oracle.publicKey.toBase58();
    const forged = {
      ...decoded,
      signatures: { ...decoded.signatures, [oracleAddress]: new Uint8Array(64).fill(7) },
    } as unknown as typeof decoded;

    await expect(
      finalizeOracleSignedGameTransaction({
        oracleSignedBase64: getBase64EncodedWireTransaction(forged),
        expectedMessageBytes: prepared.messageBytes,
        creator,
      }),
    ).rejects.toThrow(`Invalid game transaction signature for ${oracleAddress}`);
  });
});

for (const sameCluster of [true, false]) {
  test(`rebroadcast fallback verifies cluster identity (${sameCluster}) and preserves signed bytes`, async () => {
    const creator = await Keypair.generate();
    const blockhash = { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 };
    const prepared = await buildOracleSignableGameTransaction({
      creator,
      blockhash,
      instructions: [
        new TransactionInstruction({
          programId: PublicKey.default,
          keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }],
          data: Uint8Array.of(1),
        }),
      ],
    });
    const tx = await finalizeOracleSignedGameTransaction({
      creator,
      oracleSignedBase64: prepared.txBase64,
      expectedMessageBytes: prepared.messageBytes,
    });
    const signature = getSignatureFromTransaction(tx);
    const savedFetch = globalThis.fetch;
    const sends: string[] = [];
    globalThis.fetch = (async (url: any, options: any) => {
      const { method, params } = JSON.parse(options.body);
      const isPrimary = String(url).includes("primary.test");
      if (method === "getGenesisHash")
        return Response.json({ result: isPrimary || sameCluster ? "mainnet" : "other" });
      if (method === "sendTransaction") {
        sends.push(String(url));
        expect(params[0]).toBe(getBase64EncodedWireTransaction(tx));
        if (isPrimary) return new Response("unavailable", { status: 503 });
        return Response.json({ result: signature });
      }
      throw new Error(method);
    }) as any;
    try {
      const wallet = WalletManager.createForTest(MNEMONIC, {
        connection: { rpcEndpoint: "https://primary.test" } as any,
        tokenDb: {} as any,
      });
      if (sameCluster) {
        expect(await wallet.sendFullySignedGameTransaction(tx, blockhash, true)).toBe(signature);
        expect(sends).toHaveLength(2);
      } else {
        await expect(wallet.sendFullySignedGameTransaction(tx, blockhash, true)).rejects.toThrow(
          "unknown",
        );
        expect(sends).toEqual(["https://primary.test/"]);
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
}

for (const confirmationStatus of ["processed", "confirmed", "finalized"]) {
  test(`game recovery releases failed signatures only at finality (${confirmationStatus})`, async () => {
    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: {
        getSignatureStatus: async () => ({
          value: { err: { InstructionError: [0, "failed"] }, confirmationStatus },
        }),
      } as any,
      tokenDb: {} as any,
    });
    expect(await wallet.getTransactionOutcome("signature", { requireFinalizedFailure: true })).toBe(
      confirmationStatus === "finalized" ? "failed" : "unknown",
    );
  });
}
