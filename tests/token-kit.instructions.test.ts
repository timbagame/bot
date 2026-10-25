import { describe, expect, test } from "bun:test";
import { PublicKey } from "../src/utils/solana";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
} from "../src/utils/token-kit";

const key = (seed: number) => new PublicKey(new Uint8Array(32).fill(seed));

const findOffCurveKey = (): PublicKey => {
  for (let seed = 1; seed < 255; seed += 1) {
    const candidate = key(seed);
    if (!PublicKey.isOnCurve(candidate.toBytes())) return candidate;
  }
  throw new Error("no off-curve key found");
};

describe("getAssociatedTokenAddress", () => {
  test("rejects off-curve owners unless explicitly allowed", async () => {
    const owner = findOffCurveKey();
    const mint = key(200);

    await expect(getAssociatedTokenAddress(mint, owner)).rejects.toThrow(
      "Token owner is off curve",
    );

    const allowed = await getAssociatedTokenAddress(mint, owner, true);
    expect(allowed).toBeInstanceOf(PublicKey);
    const repeat = await getAssociatedTokenAddress(mint, owner, true);
    expect(repeat.equals(allowed)).toBe(true);
  });
});

describe("createCloseAccountInstruction", () => {
  test("targets the Token-2022 program when asked and the classic program by default", () => {
    const account = key(21);
    const destination = key(22);
    const owner = key(23);

    const classic = createCloseAccountInstruction(account, destination, owner);
    const token2022 = createCloseAccountInstruction(
      account,
      destination,
      owner,
      [],
      TOKEN_2022_PROGRAM_ID,
    );

    expect(classic.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(token2022.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(token2022.keys[0]!.pubkey.equals(account)).toBe(true);
    expect(token2022.keys[1]!.pubkey.equals(destination)).toBe(true);
    expect(token2022.keys[2]!.pubkey.equals(owner)).toBe(true);
    expect(token2022.keys[2]!.isSigner).toBe(true);
  });
});
