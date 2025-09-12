import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager.getUserGames categorization and sections", () => {
  test("groups recent games into won/lost/created/cancelled and lists active", async () => {
    resetGM();
    // Stub program not used (we will stub getGameInfo)
    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const player = Keypair.generate();
    const wallet = {
      getKeyPair: (_: bigint) => player,
      getTokenMetadata: async () => ({ decimals: 9 }),
      formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
    } as any;
    const playerPkStr = player.publicKey.toBase58();
    const db = {
      getActiveGames: async (_id: string) => [{ game_address: new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58() }],
      getRecentGames: async (_id: string, _limit: number) => [
        { game_address: "wonGame", winner_address: playerPkStr, creator_telegram_id: "777", completed_at: Date.now() },
        { game_address: "lostGame", winner_address: new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58(), creator_telegram_id: "888", completed_at: Date.now() },
        { game_address: "createdGame", winner_address: null, creator_telegram_id: "12345", completed_at: Date.now() },
        { game_address: "cancelledGame", winner_address: "cancelled", creator_telegram_id: "999", completed_at: Date.now() },
      ],
      getGame: (_: string) => ({ token_mint: "MINT", token_ticker: "TOK" }),
      getCreatorInfo: (_: string) => ({ telegramId: "777" }),
    } as any;

    const gm = GameManager.getInstance(program, wallet, db);
    // Patch formatting methods to isolate categorization
    (gm as any).getGameInfo = async () => "Active Game Info";
    (gm as any).getCompletedGameInfo = async () => "Completed Game Info";

    const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: { username: "user777" } }) } } as any;
    const out = await gm.getUserGames(ctx, BigInt(12345));

    expect(out.activeGames).toContain("Active Games");
    expect(out.recentGames).toContain("Won Games");
    expect(out.recentGames).toContain("Lost Games");
    expect(out.recentGames).toContain("Created Games");
    expect(out.recentGames).toContain("Cancelled Games");
  });
});
