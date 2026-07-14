import { afterEach, beforeEach, expect, test } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";

function resetGM() {
  // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

const createConnectionStub = () => ({
  rpcEndpoint: "local-test",
  getMinimumBalanceForRentExemption: async () => 0,
  getLatestBlockhash: async () => ({ blockhash: "hash", lastValidBlockHeight: 0 }),
  getFeeForMessage: async () => 0,
  getRecentPrioritizationFees: async () => [],
});

const createWalletStub = () => {
  const connection = createConnectionStub();
  const admin = Keypair.generate();
  return {
    connection,
    getConnection: () => connection,
    getKeyPair: () => admin,
    getAdminKeypair: () => admin,
    formatTokenBalance: (value: number) => value.toString(),
    formatSolBalance: (lamports: number) => lamports.toString(),
    getBlockchainTime: async () => Math.floor(Date.now() / 1000),
  } as any;
};

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  resetGM();
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

beforeEach(() => {
  resetGM();
});

test("getGameInfo returns friendly message on fetch failure", async () => {
  process.env.NODE_ENV = "test";
  const program = {
    account: {
      game: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    },
  } as any;
  const wallet = createWalletStub();
  const db = {} as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const out = await gm.getGameInfo(
    {} as any,
    new PublicKey("BPFLoader1111111111111111111111111111111111"),
  );
  expect(out).toContain("⚠️ Unable to load this game right now. Please try again in a moment.");
  expect(out).not.toContain("boom");
});

test("getGameInfo returns friendly error when token metadata missing", async () => {
  process.env.NODE_ENV = "test";

  const program = {
    account: {
      game: {
        fetch: async () => ({
          ticketAmount: 1,
          creator: Keypair.generate().publicKey,
          totalAmount: 1,
        }),
      },
    },
  } as any;

  const wallet = createWalletStub();

  const gameDb = {
    getGame: () => ({ token_mint: null, token_ticker: null }),
  } as any;

  const gm = GameManager.getInstance(program, wallet, gameDb);

  const ctx = {
    chat: { id: 1 },
    api: { getChatMember: async () => ({ user: { username: "user" } }) },
  } as any;

  const gameAddress = Keypair.generate().publicKey;

  const message = await gm.getGameInfo(ctx, gameAddress);

  expect(message).toContain("Error: Game token information not found");
});
