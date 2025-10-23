import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager orphan cleanup", () => {
  test("handleExpiredCoinflip clears stale participants when on-chain tickets are zero", async () => {
    resetGM();
    const gameAddress = "BPFLoader9999999999999999999999999999999999";
    const gamePda = new PublicKey(gameAddress);
    const creatorPubkey = new PublicKey(
      "BPFLoader1111111111111111111111111111111111"
    );
    const playerPubkey = new PublicKey(
      "BPFLoader2111111111111111111111111111111111"
    );

    let participants = ["555"];
    const dbStub = {
      getGameParticipants: (_addr: string) => [...participants],
      removeGameParticipant: (_addr: string, id: string) => {
        participants = participants.filter((value) => value !== id);
      },
      getPlayerPublicKey: (id: string) => {
        if (id === "555") return playerPubkey.toBase58();
        if (id === "777") return creatorPubkey.toBase58();
        return null;
      },
      getPlayerTelegramId: (pubkey: string) => {
        if (pubkey === playerPubkey.toBase58()) return "555";
        if (pubkey === creatorPubkey.toBase58()) return "777";
        return null;
      },
      saveGameParticipant: () => {},
      getAllPlayerMappings: () => [],
      getCreatorTelegramId: (_addr: string) => "777",
      getCreatorInfo: () => ({ telegramId: "777", publicKey: creatorPubkey.toBase58() }),
    } as any;

    const programStub = { account: { game: { fetch: async () => ({}) } } } as any;
    const walletStub = {} as any;
    const gm = GameManager.getInstance(programStub, walletStub, dbStub);

    let cancelCalled = false;
    (gm as any).cancelGameWithCreator = async () => {
      cancelCalled = true;
      return true;
    };
    (gm as any).executeCompleteCleanup = () => {
      throw new Error("executeCompleteCleanup should not be called");
    };
    (gm as any).executePartialCleanup = () => {
      throw new Error("executePartialCleanup should not be called");
    };

    const gameAccount = {
      ticketsCount: 0,
      participantHashes: [],
      creator: creatorPubkey,
      gameType: { coinflip: {} },
    };

    const result = await (gm as any).handleExpiredCoinflip(
      gamePda,
      gameAccount,
      gameAddress
    );

    expect(result).toBe(true);
    expect(cancelCalled).toBe(true);
    expect(participants).toEqual([]);
  });
});
