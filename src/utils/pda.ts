import { PublicKey } from "@solana/web3.js";

/**
 * Unified PDA (Program Derived Address) management utility
 * Consolidates PDA logic from multiple files and provides caching
 */
export class PDAManager {
  private static cache: Map<string, PublicKey> = new Map();

  private static readonly SEEDS = {
    ORACLE: "oracle",
    GAME: "game",
    PLAYER_BALANCE: "player_balance",
    GAME_TOKEN: "game_token"
  } as const;

  private static getCacheKey(seeds: (string | Buffer | PublicKey)[], programId: PublicKey): string {
    const seedStrs = seeds.map(s => {
      if (s instanceof PublicKey) return s.toBase58();
      if (s instanceof Buffer) return s.toString('hex');
      return s;
    });
    return seedStrs.join('_') + '_' + programId.toBase58();
  }

  private static findPDA(seeds: (string | Buffer | PublicKey)[], programId: PublicKey): PublicKey {
    const cacheKey = this.getCacheKey(seeds, programId);

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const bufferSeeds = seeds.map(s => {
      if (s instanceof PublicKey) {
        return s.toBuffer();
      }
      if (s instanceof Buffer) {
        return s;
      }
      // s is string
      return Buffer.from(s as string, 'utf8');
    });

    const [pda] = PublicKey.findProgramAddressSync(bufferSeeds, programId);
    this.cache.set(cacheKey, pda);
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

  static clearCache(): void {
    this.cache.clear();
  }
}
