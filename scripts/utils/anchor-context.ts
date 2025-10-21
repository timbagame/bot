import * as anchor from "@coral-xyz/anchor";
import type {
  Commitment,
  Connection,
  ConnectionConfig,
  Keypair,
} from "@solana/web3.js";
import { clusterApiUrl, Connection as Web3Connection } from "@solana/web3.js";
import type { Timba } from "../../idl/idlType";
import idl from "../../idl/idl.json";

type WalletOverride =
  | anchor.Wallet
  | Keypair
  | anchor.web3.Keypair;

type ProviderOptions = NonNullable<
  ConstructorParameters<typeof anchor.AnchorProvider>[2]
>;

export interface AnchorContextOverrides {
  /**
   * Optional commitment to use for the provider and (when created) the connection.
   * Defaults to `"confirmed"`.
   */
  commitment?: Commitment;
  /**
   * Optional preflight commitment override for the provider options.
   * Defaults to the resolved commitment.
   */
  preflightCommitment?: Commitment;
  /**
   * Pass an existing connection instead of constructing one from an RPC URL.
   */
  connection?: Connection;
  /**
   * RPC endpoint used when `connection` is not provided. Defaults to
   * `process.env.SOLANA_NETWORK` or mainnet-beta.
   */
  rpcUrl?: string;
  /**
   * Optional connection configuration passed when creating a connection from
   * the provided RPC URL.
   */
  connectionConfig?: ConnectionConfig;
  /**
   * Override the wallet used by Anchor. Accepts an Anchor wallet instance or a
   * Keypair (either Anchor or web3.js variant).
   */
  wallet?: WalletOverride;
  /**
   * Additional provider options merged with the resolved commitment values.
   */
  providerOptions?: Partial<ProviderOptions>;
}

export interface AnchorContextResult {
  provider: anchor.AnchorProvider;
  program: anchor.Program<Timba>;
}

const toAnchorKeypair = (keypair: Keypair | anchor.web3.Keypair) =>
  anchor.web3.Keypair.fromSecretKey(keypair.secretKey);

const resolveWallet = (
  adminKeypair: Keypair,
  override?: WalletOverride
): anchor.Wallet => {
  if (!override) {
    return new anchor.Wallet(toAnchorKeypair(adminKeypair));
  }

  if (override instanceof anchor.Wallet) {
    return override;
  }

  return new anchor.Wallet(toAnchorKeypair(override));
};

const resolveConnection = (
  rpcUrl: string,
  commitment: Commitment,
  connectionConfig?: ConnectionConfig
): Connection =>
  connectionConfig
    ? new Web3Connection(rpcUrl, connectionConfig)
    : new Web3Connection(rpcUrl, commitment);

export const createAnchorContext = (
  adminKeypair: Keypair,
  overrides: AnchorContextOverrides = {}
): AnchorContextResult => {
  const commitment = overrides.commitment ?? "confirmed";
  const preflightCommitment =
    overrides.preflightCommitment ?? overrides.commitment ?? commitment;

  const providerOptions = {
    commitment,
    preflightCommitment,
    ...(overrides.providerOptions ?? {}),
  } as ProviderOptions;

  const connection =
    overrides.connection ??
    resolveConnection(
      overrides.rpcUrl ?? process.env.SOLANA_NETWORK ?? clusterApiUrl("mainnet-beta"),
      commitment,
      overrides.connectionConfig
    );

  const wallet = resolveWallet(adminKeypair, overrides.wallet);

  const provider = new anchor.AnchorProvider(connection, wallet, providerOptions);
  anchor.setProvider(provider);

  const program = new anchor.Program(
    idl as Timba,
    provider
  ) as anchor.Program<Timba>;

  return { provider, program };
};
