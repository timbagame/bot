import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { detectTokenProgram } from "../src/utils/token-programs";

class StubConnection {
  constructor(private readonly owners: Record<string, PublicKey | null | undefined>) {}

  async getAccountInfo(pubkey: PublicKey) {
    const owner = this.owners[pubkey.toBase58()];
    if (owner === null) {
      return null;
    }
    if (typeof owner === "undefined") {
      return {};
    }
    return { owner } as any;
  }
}

describe("detectTokenProgram", () => {
  test("returns Token-2022 program when mint owned by Token-2022", async () => {
    const mint = new PublicKey("9wXc1ctv4EN6y7p6o1g2yDqvY9W6H3EAgL3rb9J6t22X");
    const conn = new StubConnection({ [mint.toBase58()]: TOKEN_2022_PROGRAM_ID });

    const result = await detectTokenProgram(conn as any, mint);
    expect(result).not.toBeNull();
    expect(result!.isToken2022).toBe(true);
    expect(result!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  test("throws when mint owner is missing", async () => {
    const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const conn = new StubConnection({});

    await expect(detectTokenProgram(conn as any, mint)).rejects.toThrow(
      /missing an owner/
    );
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

    expect(result).not.toBeNull();
    expect(result!.isToken2022).toBe(true);
    expect(result!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  test("returns null when mint account is missing", async () => {
    const mint = new PublicKey("2zsB6q5fkvMS4L7HhQTF19EaiqRkJWhGXZ6Q3A1tqhzd");
    const conn = new StubConnection({ [mint.toBase58()]: null });

    const result = await detectTokenProgram(conn as any, mint);
    expect(result).toBeNull();
  });

  test("throws when mint is owned by a non-token program", async () => {
    const mint = new PublicKey("7VFso2duJhy3ACRfjmqRriFwHjpRpPR4Kn6gdVd7FFzW");
    const randomOwner = new PublicKey("11111111111111111111111111111111");
    const conn = new StubConnection({ [mint.toBase58()]: randomOwner });

    await expect(detectTokenProgram(conn as any, mint)).rejects.toThrow(
      /unknown program/
    );
  });
});
