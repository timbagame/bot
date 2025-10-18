import { describe, test, expect } from "bun:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { WalletManager } from "../src/utils/wallet";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("WalletManager.transferToken", () => {

  test("sends SPL token transfer with ATA creations when missing", async () => {
    const conn: any = {
      // Mint owner is SPL program
      getAccountInfo: async (_pk: PublicKey) => ({ owner: TOKEN_PROGRAM_ID }),
    } as Partial<Connection> as any;

    // Ensure ATAs are treated as missing (findOrCreate will add them)
    conn.getAccountInfo = async (_pk: PublicKey) => null;

    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
      tokenMetadataResolver: async (mint) =>
        mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
          ? { decimals: 6 }
          : null,
    });

    // Stub sendTransaction to avoid real network
    (wm as any).sendTransaction = async () => "SIG_SPL";

    const fromId = 1n;
    const to = Keypair.generate().publicKey;
    const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const sig = await wm.transferToken(fromId, to, 1000, usdcMint.toBase58());
    expect(sig).toBe("SIG_SPL");
  });

  test("sends Token-2022 transfer when mint owned by 2022 program", async () => {
    const mint2022 = Keypair.generate().publicKey;
    const conn: any = {
      // Return owner for the mint (Token-2022)
      getAccountInfo: async (pk: PublicKey) => {
        if (pk.toBase58() === mint2022.toBase58()) return { owner: TOKEN_2022_PROGRAM_ID };
        return null; // ATAs do not exist
      },
      // Provide decimals for getTokenMetadata via getParsedAccountInfo
      getParsedAccountInfo: async (_pk: PublicKey) => ({ value: { data: { parsed: { info: { decimals: 7 } } } } }),
    } as Partial<Connection> as any;

    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
      tokenMetadataResolver: async (mint) =>
        mint === mint2022.toBase58() ? { decimals: 7 } : null,
    });
    (wm as any).sendTransaction = async () => "SIG_2022";

    const fromId = 2n;
    const to = Keypair.generate().publicKey;
    const sig = await wm.transferToken(fromId, to, 12345, mint2022.toBase58());
    expect(sig).toBe("SIG_2022");
  });
});
