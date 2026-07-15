import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { GameManager } from "../src/utils/game";
import { resolveContractVersion } from "../src/utils/contract-idl";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager participant recovery", () => {
  test("analyzePlayerKeys recovers participants from on-chain public keys", () => {
    resetGM();
    const gameAddress = "BPFLoader1111111111111111111111111111111111";
    const gamePda = new PublicKey(gameAddress);
    const creatorPubkey = new PublicKey("BPFLoader2111111111111111111111111111111111");
    const playerPubkey = new PublicKey("BPFLoader3111111111111111111111111111111111");
    const telegramId = "4242";

    const dbStub = {
      participants: [] as string[],
      publicKeysByTelegram: new Map<string, string>([[telegramId, playerPubkey.toBase58()]]),
      getGameParticipants(this: any, address: string) {
        expect(address).toBe(gameAddress);
        return [...this.participants];
      },
      getPlayerPublicKey(this: any, id: string) {
        return this.publicKeysByTelegram.get(id) ?? null;
      },
      saveGameParticipant(this: any, address: string, id: string, pubkey: string) {
        expect(address).toBe(gameAddress);
        this.participants.push(id);
        this.publicKeysByTelegram.set(id, pubkey);
      },
      getAllPlayerMappings() {
        return [{ telegram_id: telegramId, public_key: playerPubkey.toBase58() }];
      },
    } as any;

    const gm = GameManager.getInstance({} as any, {} as any, dbStub);
    const legacyHash = createHash("sha256")
      .update(Buffer.from("timba:part:v1"))
      .update(gamePda.toBuffer())
      .update(playerPubkey.toBuffer())
      .digest()
      .subarray(0, 8)
      .readBigUInt64LE(0);
    const participantData =
      resolveContractVersion() === "0.1.3"
        ? { participantHashes: [{ toString: () => legacyHash.toString() }] }
        : { participants: [playerPubkey] };

    const info = (gm as any).analyzePlayerKeys(
      gamePda,
      {
        creator: creatorPubkey,
        ticketsCount: 1,
        ...participantData,
      },
      gameAddress,
    );

    expect(info.available).toHaveLength(1);
    expect(info.available[0].telegramId).toBe(telegramId);
    expect(dbStub.participants).toEqual([telegramId]);
  });
});
