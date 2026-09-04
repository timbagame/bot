import { describe, expect, test } from "bun:test";
import { Keypair } from "#solana";
import { buildGameFundsContext } from "../src/utils/contract-adapter";

describe("contract account adapter", () => {
  const tokenMint = Keypair.generate().publicKey;
  const accounts = {
    tokenProgram: Keypair.generate().publicKey,
    gameToken: Keypair.generate().publicKey,
    gameVault: Keypair.generate().publicKey,
    gameVaultTokenAccount: Keypair.generate().publicKey,
  };

  test("builds the v0.2.0 GameToken context", () => {
    expect(buildGameFundsContext("0.2.0", tokenMint, accounts)).toMatchObject({
      gameTokenCtx: {
        tokenMint,
        gameToken: accounts.gameToken,
        gameVault: accounts.gameVault,
        gameTokenAccount: accounts.gameVaultTokenAccount,
      },
    });
  });

  test("builds the v0.3.0 shared-vault context", () => {
    expect(buildGameFundsContext("0.3.0", tokenMint, accounts)).toMatchObject({
      gameVaultCtx: {
        tokenMint,
        gameVault: accounts.gameVault,
        gameVaultTokenAccount: accounts.gameVaultTokenAccount,
      },
    });
  });
});
