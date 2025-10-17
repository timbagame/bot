import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

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
  test("resolveGameTokenAccounts uses Token-2022 program when mint owned by 2022 program", async () => {
    resetGM();
    const mint = Keypair.generate().publicKey;
    const programId = Keypair.generate().publicKey;
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
      getKeyPair: (_: bigint) => Keypair.generate(),
    } as any;

    const gm = GameManager.getInstance(program, wallet, {
      getGameParticipants: () => [],
    } as any);

    const seenPrograms: PublicKey[] = [];
    (gm as any).deriveAta = async (
      _mint: PublicKey,
      ownerPk: PublicKey,
      programId: PublicKey
    ) => {
      seenPrograms.push(programId);
      return ownerPk;
    };

    const accounts = await (gm as any).resolveGameTokenAccounts(mint);
    expect(accounts.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(seenPrograms.length).toBeGreaterThan(0);
    const firstProgram = seenPrograms[0];
    expect(firstProgram).toBeDefined();
    expect(firstProgram!.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);

    await (gm as any).resolveGameTokenAccounts(mint);
    expect(connection.__getCallCount()).toBe(1);
  });
});
