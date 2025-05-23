import * as anchor from "@coral-xyz/anchor";

/**
 * Bot-specific type definitions
 */

export interface ParsedAmount {
  amount: number;
  isSol: boolean;
  formattedAmount: string;
}

export interface PlayerData {
  keypair: anchor.web3.Keypair;
  tokenBalance: number;
  solBalance: number;
  gameBalance: number;
}
