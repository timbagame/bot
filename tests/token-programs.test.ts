import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { detectTokenProgram } from "../src/utils/token-programs";

class StubConnection {
  constructor(private readonly owners: Record<string, PublicKey | null>) {}

  async getAccountInfo(pubkey: PublicKey) {
    const owner = this.owners[pubkey.toBase58()];
    if (!owner) {
      return null;
    }
    return { owner } as any;
  }
}

describe("detectTokenProgram", () => {
  test("returns Token-2022 program when mint owned by Token-2022", async () => {
    const mint = new PublicKey("9wXc1ctv4EN6y7p6o1g2yDqvY9W6H3EAgL3rb9J6t22X");
    const conn = new StubConnection({ [mint.toBase58()]: TOKEN_2022_PROGRAM_ID });

    const result = await detectTokenProgram(conn as any, mint);
    expect(result.isToken2022).toBe(true);
    expect(result.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  test("defaults to legacy token program when mint owner missing", async () => {
    const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const conn = new StubConnection({});

    const result = await detectTokenProgram(conn as any, mint);
    expect(result.isToken2022).toBe(false);
    expect(result.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  test("uses provided account info without RPC lookup", async () => {
    const mint = new PublicKey("4Nd1mKaoE8Gk7fS3nFdo9szgjKfZstPg7EdMfFoKwA9u");
    const throwingConn = {
      async getAccountInfo() {
        throw new Error("should not call getAccountInfo");
      },
    };

    const result = await detectTokenProgram(
      throwingConn as any,
      mint,
      { owner: TOKEN_2022_PROGRAM_ID }
    );

    expect(result.isToken2022).toBe(true);
    expect(result.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});
