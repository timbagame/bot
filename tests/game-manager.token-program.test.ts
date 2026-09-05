import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "#solana";
import { TOKEN_2022_PROGRAM_ID } from "#token";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function createConnectionStub(owner: PublicKey) {
  let callCount = 0;
  return {
    getAccountInfo: async () => {
      callCount++;
      return { owner };
    },
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    }),
    __getCallCount: () => callCount,
  } as any;
}

describe("GameManager token program resolution", () => {
  test("resolveGameVaultAccounts rejects Token-2022 mints", async () => {
    resetGM();
    const mint = (await Keypair.generate()).publicKey;
    const programId = (await Keypair.generate()).publicKey;
    const connection = createConnectionStub(TOKEN_2022_PROGRAM_ID);

    const program = {
      programId,
      provider: { connection },
      methods: {},
      account: { game: { fetch: async () => ({}) } },
    } as any;

    const wallet = {
      connection,
      getConnection: () => connection,
      getKeyPair: async (_: bigint) => await Keypair.generate(),
    } as any;

    const gm = GameManager.getInstance(program, wallet, {
      getGameParticipants: () => [],
    } as any);

    await expect((gm as any).resolveGameVaultAccounts(mint)).rejects.toThrow(
      "Timba only supports legacy SPL Token mints",
    );
    expect(connection.__getCallCount()).toBe(1);
  });
});
