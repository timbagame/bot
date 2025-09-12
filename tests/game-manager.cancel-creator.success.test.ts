import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";

function resetGM() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("cancelGameWithCreator returns true on successful close", async () => {
  resetGM();
  const creator = Keypair.generate();
  const program = {
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
  } as any;
  const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);
  const ok = await (gm as any).cancelGameWithCreator(
    new PublicKey("BPFLoader1111111111111111111111111111111111"),
    { creator: creator.publicKey },
    "777",
    "ADDR",
    "coinflip"
  );
  expect(ok).toBe(true);
});

