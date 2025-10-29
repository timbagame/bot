import { expect, test } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

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

test("getTokenBalance waits for confirmation before returning new ATA balance", async () => {
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const accountLamports = 123_456n;

  let expectedAta: PublicKey | null = null;
  let accountCreated = false;
  let accountData = Buffer.alloc(AccountLayout.span);

  const connection = {
    async getAccountInfo(pubkey: PublicKey) {
      if (!accountCreated || !expectedAta || !pubkey.equals(expectedAta)) {
        return null;
      }
      return {
        owner: TOKEN_PROGRAM_ID,
        data: accountData,
      };
    },
  };

  const wm = WalletManager.createForTest(MNEMONIC, {
    connection: connection as any,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });

  const telegramId = 77n;
  const userKeypair = wm.getKeyPair(telegramId);
  AccountLayout.encode(
    {
      mint,
      owner: userKeypair.publicKey,
      amount: accountLamports,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    accountData
  );
  expectedAta = await getAssociatedTokenAddress(
    mint,
    userKeypair.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  (wm as any).findOrCreateAssociatedTokenAccount = async () => ({
    address: expectedAta!,
    instructions: ["ix"],
  });

  const signature = "ATA123";
  const confirmed: string[] = [];
  (wm as any).sendTransaction = async () => signature;
  (wm as any).confirmTransaction = async (sig: string) => {
    confirmed.push(sig);
    accountCreated = true;
  };

  const balance = await wm.getTokenBalance(telegramId, mint.toBase58(), {
    createIfMissing: true,
  });

  expect(confirmed).toEqual([signature]);
  expect(balance).toBe(Number(accountLamports));
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
