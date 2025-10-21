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
  afterEach(() => { process.env.SOLANA_NETWORK = orig || process.env.SOLANA_NETWORK!; });
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

    const ensureCalls: Array<{
      mint: PublicKey;
      result: Awaited<ReturnType<WalletManager["ensureAssociatedTokenAccount"]>>;
    }> = [];
    const originalEnsure = wm.ensureAssociatedTokenAccount.bind(wm);
    wm.ensureAssociatedTokenAccount = (async (
      owner: PublicKey,
      mint: PublicKey,
      payer: Keypair
    ) => {
      const result = await originalEnsure(owner, mint, payer);
      ensureCalls.push({ mint, result });
      return result;
    }) as WalletManager["ensureAssociatedTokenAccount"];

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

    expect(ensureCalls).toHaveLength(2);
    const mintCalls = ensureCalls.map((c) => c.mint.toBase58());
    expect(mintCalls).toEqual(
      expect.arrayContaining([quote.inputMint, quote.outputMint])
    );

    const inputCall = ensureCalls.find((c) => c.mint.equals(t22Mint));
    expect(inputCall).toBeDefined();
    expect(inputCall!.result.isToken2022).toBe(true);
    expect(
      inputCall!.result.programId.equals(TOKEN_2022_PROGRAM_ID)
    ).toBe(true);
    expect(inputCall!.result.created).toBe(true);

    const outputCall = ensureCalls.find((c) => c.mint.equals(splMint));
    expect(outputCall).toBeDefined();
    expect(outputCall!.result.isToken2022).toBe(false);
    expect(outputCall!.result.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(outputCall!.result.created).toBe(true);

    const creationIxs = ensureCalls.flatMap((c) => c.result.instructions);
    expect(ix).toEqual(creationIxs);
  });
});
