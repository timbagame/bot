import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

function resetGM() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("cancelGameWithCreator returns true on successful close", async () => {
  resetGM();
  const creator = Keypair.generate();
  const connection = {
    getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 6 } } } } }),
  } as any;
  const program = {
    programId: new PublicKey("BPFLoader1111111111111111111111111111111111"),
    provider: { connection },
    methods: {
      closeGame: () => ({
        accounts: (_: any) => ({ instruction: async () => ({}) }),
      }),
    },
  } as any;
  const wallet = {
    getKeyPair: (_: bigint) => creator,
    sendTransaction: async () => "SIG",
    confirmTransaction: async () => {},
    getConnection: () => connection,
  } as any;
  const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);
  const tokenMint = Keypair.generate().publicKey;
  const gameToken = Keypair.generate().publicKey;
  const gameVault = Keypair.generate().publicKey;
  const gameTokenAccount = Keypair.generate().publicKey;
  (gm as any).resolveGameTokenAccounts = async (mint: PublicKey) => {
    expect(mint.toBase58()).toBe(tokenMint.toBase58());
    return {
      tokenProgram: TOKEN_PROGRAM_ID,
      gameToken,
      gameVault,
      gameTokenAccount,
    };
  };
  const ok = await (gm as any).cancelGameWithCreator(
    new PublicKey("BPFLoader1111111111111111111111111111111111"),
    {
      creator: creator.publicKey.toBase58(),
      tokenMint: tokenMint.toBase58(),
    },
    "777",
    "ADDR",
    "coinflip"
  );
  expect(ok).toBe(true);
});

