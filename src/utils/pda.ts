import { PublicKey } from "@solana/web3.js";

/**
 * Simplified PDA (Program Derived Address) management utility
 */
export class PDAManager {
  private static readonly SEEDS = {
    ORACLE: "oracle",
    GAME: "game",
    PLAYER_BALANCE: "player_balance",
    GAME_TOKEN: "game_token"
  } as const;

  private static findPDA(seeds: (string | Buffer | PublicKey)[], programId: PublicKey): PublicKey {
    const bufferSeeds = seeds.map(s => {
      if (s instanceof PublicKey) return s.toBuffer();
      if (s instanceof Buffer) return s;
      return Buffer.from(s as string, 'utf8');
    });

    const [pda] = PublicKey.findProgramAddressSync(bufferSeeds, programId);
    return pda;
  }

  static getOraclePDA(programId: PublicKey): PublicKey {
    return this.findPDA([this.SEEDS.ORACLE], programId);
  }

  static getGamePDA(randomHash: Buffer, programId: PublicKey): PublicKey {
    return this.findPDA([this.SEEDS.GAME, randomHash], programId);
  }

  static getPlayerBalancePDA(playerPubkey: PublicKey, tokenMint: PublicKey, programId: PublicKey): PublicKey {
    return this.findPDA([this.SEEDS.PLAYER_BALANCE, playerPubkey, tokenMint], programId);
  }

  static getGameTokenPDA(tokenMint: PublicKey, programId: PublicKey): PublicKey {
    return this.findPDA([this.SEEDS.GAME_TOKEN, tokenMint], programId);
  }
}
