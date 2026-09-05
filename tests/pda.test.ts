import { expect, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { PDAManager } from "../src/utils/pda";

test("getOraclePDA derives expected address", async () => {
  const programId = Keypair.generate().publicKey;
  const expected = PublicKey.findProgramAddressSync([Buffer.from("oracle")], programId)[0];
  const pda = await PDAManager.getOraclePDA(programId);
  expect(pda.toBase58()).toBe(expected.toBase58());
});

test("getGamePDA derives expected address", async () => {
  const programId = Keypair.generate().publicKey;
  const randomHash = Buffer.alloc(32, 7);
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), randomHash],
    programId,
  )[0];
  const pda = await PDAManager.getGamePDA(randomHash, programId);
  expect(pda.toBase58()).toBe(expected.toBase58());
});
