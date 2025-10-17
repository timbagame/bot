import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("analyzePlayerKeys classifies available/unavailable and creator", () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const creator = new PublicKey("BPFLoader1111111111111111111111111111111111");
  const gamePda = new PublicKey("BPFLoader2111111111111111111111111111111111");
  const db = {
    getGameParticipants: (_addr: string) => ["777", "888"],
    getPlayerPublicKey: (id: string) => (id === "777" ? creator.toBase58() : null),
    getAllPlayerMappings: () => [],
    saveGameParticipant: () => {},
  } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const info = (gm as any).analyzePlayerKeys(
    gamePda,
    { creator },
    gamePda.toBase58()
  );
  expect(info.available.length).toBe(1);
  expect(info.unavailable.length).toBe(1);
  expect(info.creator).toBeDefined();
  expect(info.nonCreators.length).toBe(0);
  expect(info.canCompleteCleanup).toBe(false);
});

test("analyzePlayerKeys recovers missing participants from hashes", () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const gamePda = new PublicKey("BPFLoader3111111111111111111111111111111111");
  const creatorKey = new PublicKey("BPFLoader4111111111111111111111111111111111");
  const recoveredKey = new PublicKey("BPFLoader5111111111111111111111111111111111");
  const participants = new Set(["creator" as const]);
  const saved: Array<{ telegramId: string; publicKey: string }> = [];

  const db = {
    getGameParticipants: (_addr: string) => Array.from(participants),
    getPlayerPublicKey: (id: string) => {
      if (id === "creator") return creatorKey.toBase58();
      if (id === "missing") return recoveredKey.toBase58();
      return null;
    },
    getAllPlayerMappings: () => [
      { telegram_id: "creator", public_key: creatorKey.toBase58() },
      { telegram_id: "missing", public_key: recoveredKey.toBase58() },
    ],
    saveGameParticipant: (_addr: string, telegramId: string, publicKey: string) => {
      participants.add(telegramId as "creator" | "missing");
      saved.push({ telegramId, publicKey });
    },
  } as any;

  const gm = GameManager.getInstance(program, wallet, db);
  const hashCreator = (gm as any).computeParticipantHash(gamePda, creatorKey);
  const hashRecovered = (gm as any).computeParticipantHash(gamePda, recoveredKey);
  const info = (gm as any).analyzePlayerKeys(
    gamePda,
    { creator: creatorKey, participantHashes: [hashCreator, hashRecovered] },
    gamePda.toBase58()
  );

  expect(saved).toEqual([
    {
      telegramId: "missing",
      publicKey: recoveredKey.toBase58(),
    },
  ]);
  expect(info.available.length).toBe(2);
  expect(info.unavailable.length).toBe(0);
  expect(info.creator?.pubkey?.equals(creatorKey)).toBe(true);
  expect(info.nonCreators.length).toBe(1);
  expect(info.total).toBe(2);
});

