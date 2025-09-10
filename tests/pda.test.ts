import { expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PDAManager } from "../src/utils/pda";

test("getOraclePDA derives expected address", () => {
  const programId = Keypair.generate().publicKey;
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    programId
  )[0];
  const pda = PDAManager.getOraclePDA(programId);
  expect(pda.toBase58()).toBe(expected.toBase58());
});

test("getGamePDA derives expected address", () => {
  const programId = Keypair.generate().publicKey;
  const randomHash = Buffer.from("seed123");
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), randomHash],
    programId
  )[0];
  const pda = PDAManager.getGamePDA(randomHash, programId);
  expect(pda.toBase58()).toBe(expected.toBase58());
});

test("getGameTokenPDA derives expected address", () => {
  const programId = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), tokenMint.toBuffer()],
    programId
  )[0];
  const pda = PDAManager.getGameTokenPDA(tokenMint, programId);
  expect(pda.toBase58()).toBe(expected.toBase58());
});

test("getPlayerParticipationPDA derives expected address", () => {
  const programId = Keypair.generate().publicKey;
  const gameAddress = Keypair.generate().publicKey;
  const playerPubkey = Keypair.generate().publicKey;
  const expected = PublicKey.findProgramAddressSync(
    [
      Buffer.from("player_participation"),
      gameAddress.toBuffer(),
      playerPubkey.toBuffer(),
    ],
    programId
  )[0];
  const pda = PDAManager.getPlayerParticipationPDA(
    gameAddress,
    playerPubkey,
    programId
  );
  expect(pda.toBase58()).toBe(expected.toBase58());
});
