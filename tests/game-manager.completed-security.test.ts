import { afterEach, expect, test } from "bun:test";
import { GameManager } from "../src/utils/game";
import { Keypair } from "@solana/web3.js";

const resetGM = () => {
  Reflect.set(GameManager as unknown as Record<string, unknown>, "instance", undefined);
};

const createConnectionStub = () => ({
  rpcEndpoint: "local-security",
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

test("getCompletedGameInfo escapes token ticker to prevent HTML injection", async () => {
  process.env.NODE_ENV = "test";

  const program = {
    account: {
      game: {
        fetch: async () => ({
          ticketAmount: 100,
          creator: Keypair.generate().publicKey,
          totalAmount: 100,
        }),
      },
    },
  } as any;

  const wallet = createWalletStub();

  const gameDb = {
    getGameParticipants: () => [] as string[],
  } as any;

  const gm = GameManager.getInstance(program, wallet, gameDb);

  (gm as any).resolveTokenFormattingInfo = async () => ({
    formatBalance: (value: number) => value.toString(),
    decimals: 6,
    tokenMint: "Mint",
    isSol: false,
  });

  (gm as any).getUsernameFromTelegramId = async () => "creator";
  (gm as any).getPlayerUsername = async () => "@winner";

  const ctx = {
    chat: { id: 99 },
    api: { getChatMember: async () => ({ user: { username: "creator" } }) },
  } as any;

  const maliciousTicker = "<script>alert(1)</script>";
  const gameAddress = Keypair.generate().publicKey.toBase58();

  const output = await gm.getCompletedGameInfo(ctx, {
    creator_telegram_id: "123",
    amount: 1_000_000,
    game_type: "coinflip",
    token_ticker: maliciousTicker,
    token_mint: "Mint",
    max_players: 5,
    game_address: gameAddress,
    winner_address: "cancelled",
    completed_at: Date.now(),
  });

  expect(output).not.toContain("<script>");
  expect(output).toContain("&lt;script&gt;");
});
