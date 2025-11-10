import { afterEach, expect, test } from "bun:test";
import { GameManager } from "../src/utils/game";
import { Keypair } from "@solana/web3.js";

const resetGM = () => {
  Reflect.set(GameManager as unknown as Record<string, unknown>, "instance", undefined);
};

const createConnectionStub = () => ({
  rpcEndpoint: "local-username",
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

test("getUsernameFromTelegramId shares in-flight lookups", async () => {
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
    getGameParticipants: () => [] as string[],
    saveUsernameMapping: () => {},
    findTelegramIdByNormalizedUsername: () => null,
  } as any;

  const gm = GameManager.getInstance(program, wallet, gameDb);

  let callCount = 0;
  const ctx = {
    chat: { id: 777 },
    api: {
      getChatMember: async (chatId: number, userId: number) => {
        callCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { user: { username: `user_${chatId}_${userId}` } };
      },
    },
  } as any;

  const lookups = await Promise.all([
    gm.getUsernameFromTelegramId(ctx, "42"),
    gm.getUsernameFromTelegramId(ctx, "42"),
    gm.getUsernameFromTelegramId(ctx, "42"),
  ]);

  expect(lookups).toEqual([
    "@user_777_42",
    "@user_777_42",
    "@user_777_42",
  ]);
  expect(callCount).toBe(1);
});
