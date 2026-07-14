import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager orphaned scan helpers", () => {
  test("findOrphanedGames returns unknown games from chain", async () => {
    resetGM();
    const first = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();
    const second = new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58();
    const program = {
      account: {
        game: {
          all: async () => [
            { publicKey: new PublicKey(first), account: { ticketsCount: 0, maxTickets: 2 } },
            { publicKey: new PublicKey(second), account: { ticketsCount: 1, maxTickets: 2 } },
          ],
        },
      },
    } as any;
    const db = { gameExists: (addr: string) => addr === first } as any;
    const gm = GameManager.getInstance(program, {} as any, db);
    const res = await (gm as any).findOrphanedGames();
    expect(res.length).toBe(1);
    expect(res[0]!.address).toBe(second);
  });
});
