import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager.generateGameKeyboard", () => {
  test("returns empty for completed and join/refresh for active", () => {
    resetGM();
    const gm = GameManager.getInstance({} as any, {} as any, {} as any);
    const addr = new PublicKey("BPFLoader1111111111111111111111111111111111");
    const empty = (gm as any).generateGameKeyboard("Completed", addr);
    expect(Array.isArray(empty)).toBe(true);
    expect(empty.length).toBe(0);

    const kb = (gm as any).generateGameKeyboard("Active", addr);
    const fl = (kb.flat ? kb.flat() : kb[0]) as any[];
    const callbacks = fl.map((b) => b.callback_data);
    expect(callbacks.some((s) => String(s).startsWith("join_"))).toBe(true);
    expect(callbacks.some((s) => String(s).startsWith("refresh_"))).toBe(true);

    const joinButton = fl.find((b) => String(b.callback_data).startsWith("join_"));
    expect(joinButton?.text).toBe("🎮 Join");
  });
});
