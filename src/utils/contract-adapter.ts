import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { PublicKey } from "@solana/web3.js";
import { getContractCapabilities, type ContractVersion } from "@timbagame/protocol/contracts";

export interface ResolvedContractTokenAccounts {
  tokenProgram: PublicKey;
  gameToken: PublicKey;
  gameVault: PublicKey;
  gameVaultTokenAccount: PublicKey;
}

export function buildGameFundsContext(
  version: ContractVersion,
  tokenMint: PublicKey,
  accounts: ResolvedContractTokenAccounts,
): Record<string, Record<string, PublicKey>> {
  const common = {
    tokenMint,
    gameVault: accounts.gameVault,
    tokenProgram: accounts.tokenProgram,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  };

  return getContractCapabilities(version).gameTokenAccount
    ? {
        gameTokenCtx: {
          ...common,
          gameToken: accounts.gameToken,
          gameTokenAccount: accounts.gameVaultTokenAccount,
        },
      }
    : {
        gameVaultCtx: {
          ...common,
          gameVaultTokenAccount: accounts.gameVaultTokenAccount,
        },
      };
}
