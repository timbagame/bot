import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { GAME_EXPIRATION_BUFFER_TIME } from "../src/utils/constants";
// PublicKey not needed in this test

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function programStub() {
  return { account: { game: { fetch: async () => ({}) } } } as any;
}
function walletStub() {
  return {} as any;
}
function dbStub() {
  return { getGameParticipants: () => [] } as any;
}

describe("GameManager private helpers", () => {
  test("isGameExpiredWithBuffer respects timeout and buffer", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const now = Math.floor(Date.now() / 1000);
    const expired = (gm as any).isGameExpiredWithBuffer({
      createdAt: now - (60 + GAME_EXPIRATION_BUFFER_TIME + 1),
      timeout: 60,
    });
    const notExpired = (gm as any).isGameExpiredWithBuffer({ createdAt: now - 50, timeout: 60 });
    expect(expired).toBe(true);
    expect(notExpired).toBe(false);
  });

  test("getGameType returns first key or unknown", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    expect((gm as any).getGameType({ gameType: { coinflip: {} } })).toBe("coinflip");
    expect((gm as any).getGameType({ gameType: {} })).toBe("unknown");
  });

  test("handleGameProcessingError maps account missing to true, others to false", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    expect((gm as any).handleGameProcessingError(new Error("Account does not exist"), "addr")).toBe(
      true,
    );
    expect((gm as any).handleGameProcessingError(new Error("boom"), "addr")).toBe(false);
  });
});
