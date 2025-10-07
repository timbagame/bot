import { expect, test } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { WalletManager } from "../src/utils/wallet";

class MintAwareConnection {
  private mintKey: string;

  constructor(mint: PublicKey) {
    this.mintKey = mint.toBase58();
  }

  async getAccountInfo(pubkey: PublicKey) {
    if (pubkey.toBase58() === this.mintKey) {
      return { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0) };
    }
    return null;
  }
}

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("getTokenBalance creates ATA with user as payer when missing", async () => {
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const wm = WalletManager.createForTest(MNEMONIC, {
    connection: new MintAwareConnection(mint) as any,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });

  const telegramId = 5n;
  const userKeypair = wm.getKeyPair(telegramId);
  const creationCalls: Array<{
    owner: PublicKey;
    payer: Keypair;
    mint: PublicKey;
  }> = [];
  const sendCalls: Array<{ signers: Keypair[] }> = [];

  (wm as any).findOrCreateAssociatedTokenAccount = async (
    owner: PublicKey,
    mintPk: PublicKey,
    payer: Keypair
  ) => {
    creationCalls.push({ owner, payer, mint: mintPk });
    return { address: Keypair.generate().publicKey, instructions: ["ix"] };
  };

  (wm as any).sendTransaction = async (_ixs: any[], signers: Keypair[]) => {
    sendCalls.push({ signers });
    throw new Error("simulate failure post-send");
  };

  const balance = await wm.getTokenBalance(telegramId, mint.toBase58(), {
    createIfMissing: true,
  });

  expect(balance).toBe(0);
  expect(creationCalls.length).toBe(1);
  expect(sendCalls.length).toBe(1);

  expect(creationCalls[0]!.payer.publicKey.equals(userKeypair.publicKey)).toBe(
    true
  );
  expect(
    sendCalls[0]!.signers.some((kp) =>
      kp.publicKey.equals(userKeypair.publicKey)
    )
  ).toBe(true);
});

test("getTokenBalance without createIfMissing does not attempt ATA creation", async () => {
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const wm = WalletManager.createForTest(MNEMONIC, {
    connection: new MintAwareConnection(mint) as any,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });

  const telegramId = 42n;
  let creationAttempted = false;
  (wm as any).findOrCreateAssociatedTokenAccount = () => {
    creationAttempted = true;
    return { address: Keypair.generate().publicKey, instructions: [] };
  };

  const balance = await wm.getTokenBalance(telegramId, mint.toBase58());

  expect(balance).toBe(0);
  expect(creationAttempted).toBe(false);
});

