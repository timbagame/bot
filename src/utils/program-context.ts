import type { Commitment, Connection, ConnectionConfig, Keypair } from "#solana";
import { Connection as SolanaConnection, clusterApiUrl } from "#solana";
import { WalletManager } from "./wallet";
import { loadWalletMnemonic } from "./secrets";
import { resolvePrimaryRpcEndpoint } from "./rpc-endpoints";
import { createTimbaProgram, type TimbaProgram } from "./timba-program";

export interface ProgramContextOverrides {
  /**
   * Optional commitment to use for the program client and any new connection.
   * Defaults to `"confirmed"`.
   */
  commitment?: Commitment;
  /** Pass an existing connection instead of constructing one from an RPC URL. */
  connection?: Connection;
  /**
   * RPC endpoint used when `connection` is not provided. Defaults to
   * `process.env.SOLANA_NETWORK` or mainnet-beta.
   */
  rpcUrl?: string;
  /** Optional configuration for a newly created connection. */
  connectionConfig?: ConnectionConfig;
}

export interface ProgramContextResult {
  provider: { connection: Connection };
  program: TimbaProgram;
}

export type ProgramContextLoadOptions = ProgramContextOverrides & {
  mnemonic?: string;
  wallet?: WalletManager;
};

export interface LoadedProgramContext extends ProgramContextResult {
  wallet: WalletManager;
  operatorKeypair: Keypair;
  connection: Connection;
}

const resolveConnection = (
  rpcUrl: string,
  commitment: Commitment,
  connectionConfig?: ConnectionConfig,
): Connection =>
  connectionConfig
    ? new SolanaConnection(rpcUrl, connectionConfig)
    : new SolanaConnection(rpcUrl, commitment);

export const createProgramContext = (
  overrides: ProgramContextOverrides = {},
): ProgramContextResult => {
  const commitment = overrides.commitment ?? "confirmed";
  const resolvedRpcUrl = resolvePrimaryRpcEndpoint(
    overrides.rpcUrl ?? process.env.SOLANA_NETWORK,
    clusterApiUrl("mainnet-beta"),
  );
  const connection =
    overrides.connection ??
    resolveConnection(resolvedRpcUrl, commitment, overrides.connectionConfig);
  const provider = { connection };
  const program = createTimbaProgram(connection);
  return { provider, program };
};

export const loadProgramContext = (
  options: ProgramContextLoadOptions = {},
): LoadedProgramContext => {
  const { mnemonic, wallet: walletOverride, ...programOverrides } = options;
  const resolvedMnemonic = mnemonic?.trim() || loadWalletMnemonic();
  const wallet = walletOverride ?? WalletManager.getInstance(resolvedMnemonic);
  const operatorKeypair = wallet.getOperatorKeypair();
  const context = createProgramContext({
    ...programOverrides,
    connection: programOverrides.connection ?? wallet.getConnection(),
  });
  return {
    wallet,
    operatorKeypair,
    program: context.program,
    provider: context.provider,
    connection: context.provider.connection,
  };
};
