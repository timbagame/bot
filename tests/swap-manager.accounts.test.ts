import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

class FakeConnection implements Partial<Connection> {
  constructor(private mintOwners: Record<string, PublicKey>) {}
  async getAccountInfo(pubkey: PublicKey) {
    // Return owner for known mints to drive Token-2022 vs SPL branching
    const owner = this.mintOwners[pubkey.toBase58()];
    if (owner) return { owner } as any;
    // For ATAs or anything else, pretend missing to force creation
    return null as any;
  }
}

describe("SwapManager token account setup", () => {
  let orig: string | undefined;
  beforeEach(() => { orig = process.env.SOLANA_NETWORK; process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; });
  afterEach(() => { process.env.SOLANA_NETWORK = orig; });
  test("creates ATAs for SPL and Token-2022 mints when missing", async () => {
    const user = Keypair.generate();

    const splMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC (SPL)
    const t22Mint = new PublicKey("9wXc1ctv4EN6y7p6o1g2yDqvY9W6H3EAgL3rb9J6t22X"); // fake 2022 mint

    const conn = new FakeConnection({
      [splMint.toBase58()]: TOKEN_PROGRAM_ID,
      [t22Mint.toBase58()]: TOKEN_2022_PROGRAM_ID,
    }) as any as Connection;

    const wm = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection: conn, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(conn, wm);

    // Stub pump fun path to avoid network
    (sm.pumpFunClient as any).createSwapTransaction = async () => [] as TransactionInstruction[];

    const quote = {
      inputMint: t22Mint.toBase58(),
      outputMint: splMint.toBase58(),
      inputAmount: "1000000",
      outputAmount: "1000",
      estimatedRate: 0.001,
      slippage: 1,
      provider: "pump-fun" as const,
    };

    const req = {
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inputAmount,
      slippageBps: 100,
      userKeypair: user,
      inputDecimals: 6,
      outputDecimals: 6,
      inputTicker: "T22",
      outputTicker: "USDC",
    };

    const ix = await sm.createSwapTransaction(req, quote);
    // Expect at least two setup instructions for input/output ATAs
    expect(ix.length).toBeGreaterThanOrEqual(2);
  });
});
