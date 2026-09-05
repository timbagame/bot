import { PublicKey } from "#solana";
import { getContractClient } from "@timbagame/protocol/contracts/client";
import { findGameTokenPda } from "@timbagame/protocol/contracts/v0.2.0/kit";
import { contractVersion } from "./contract-idl";

const client = getContractClient(contractVersion);

/** Converts generated Kit addresses at the bot's PublicKey boundary. */
export class PDAManager {
  static async getOraclePDA(programId: PublicKey): Promise<PublicKey> {
    const [pda] = await client.findOraclePda({ programAddress: programId.toBase58() });
    return new PublicKey(pda);
  }

  static async getGamePDA(randomHash: Buffer, programId: PublicKey): Promise<PublicKey> {
    if (randomHash.length !== 32) throw new Error("Game random hash must be 32 bytes");
    const [pda] = await client.findGamePda(
      { randomHash },
      { programAddress: programId.toBase58() },
    );
    return new PublicKey(pda);
  }

  static async getGameVaultPDA(tokenMint: PublicKey, programId: PublicKey): Promise<PublicKey> {
    const [pda] = await client.findGameVaultPda(
      { tokenMint: tokenMint.toBase58() },
      { programAddress: programId.toBase58() },
    );
    return new PublicKey(pda);
  }

  /** Legacy v0.2 account address, also used when inspecting historical accounts. */
  static async getGameTokenPDA(tokenMint: PublicKey, programId: PublicKey): Promise<PublicKey> {
    const [pda] = await findGameTokenPda(
      { tokenMint: tokenMint.toBase58() },
      { programAddress: programId.toBase58() },
    );
    return new PublicKey(pda);
  }
}
