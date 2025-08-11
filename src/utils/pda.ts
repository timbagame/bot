import { PublicKey } from "@solana/web3.js";

/**
 * Simplified PDA (Program Derived Address) management utility
 * Centralizes all PDA generation logic for the gaming program
 */
export class PDAManager {
  private static readonly SEEDS = {
    GAME: "game",
    PLAYER_GAMES: "player_games",
    GAME_TOKEN: "game_token",
    PLAYER_PARTICIPATION: "player_participation",
    ORACLE: "oracle",
  } as const;

  /**
   * Internal helper to find PDA from seeds and program ID
   */
  private static findPDA(
    seeds: (string | Buffer | PublicKey)[],
    programId: PublicKey
  ): PublicKey {
    const bufferSeeds = seeds.map((s) => {
      if (s instanceof PublicKey) return s.toBuffer();
      if (s instanceof Buffer) return s;
      return Buffer.from(s as string, "utf8");
    });

    const [pda] = PublicKey.findProgramAddressSync(bufferSeeds, programId);
    return pda;
  }

  /**
   * Get Oracle PDA - Used for oracle configuration
   */
  static getOraclePDA(programId: PublicKey): PublicKey {
    return this.findPDA([this.SEEDS.ORACLE], programId);
  }

  /**
   * Get Game PDA - Derived from random hash only (no nonce)
   */
  static getGamePDA(randomHash: Buffer, programId: PublicKey): PublicKey {
    return this.findPDA([this.SEEDS.GAME, randomHash], programId);
  }

  /**
   * Get Player Balance PDA - Used for player's token balance in games
   */

  /**
   * Get Player Games PDA - New account tracking player participation metadata
   */
  static getPlayerGamesPDA(
    playerPubkey: PublicKey,
    tokenMint: PublicKey,
    programId: PublicKey
  ): PublicKey {
    return this.findPDA(
      [this.SEEDS.PLAYER_GAMES, playerPubkey, tokenMint],
      programId
    );
  }

  /**
   * Get Game Token PDA - Used for game token configuration
   */
  static getGameTokenPDA(
    tokenMint: PublicKey,
    programId: PublicKey
  ): PublicKey {
    return this.findPDA([this.SEEDS.GAME_TOKEN, tokenMint], programId);
  }

  /**
   * Get Player Participation PDA - Used to track player participation in specific games
   */
  static getPlayerParticipationPDA(
    gameAddress: PublicKey,
    playerPubkey: PublicKey,
    programId: PublicKey
  ): PublicKey {
    return this.findPDA(
      [this.SEEDS.PLAYER_PARTICIPATION, gameAddress, playerPubkey],
      programId
    );
  }
}
