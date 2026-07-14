import * as anchor from "@anchor-lang/core";
import type {
  Commitment,
  Connection,
  ConnectionConfig,
  Keypair,
} from "@solana/web3.js";
import { clusterApiUrl } from "@solana/web3.js";
import type { Timba } from "../../idl/idlType";
import idl from "../../idl/idl.json";
import { WalletManager } from "../../src/utils/wallet";
import { loadWalletMnemonic } from "../../src/utils/secrets";
import { resolvePrimaryRpcEndpoint } from "../../src/utils/rpc-endpoints";

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
  connection?: Connection | anchor.web3.Connection;
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

export type ProgramContextLoadOptions = Omit<
  AnchorContextOverrides,
  "wallet"
> & {
  mnemonic?: string;
  wallet?: WalletManager;
};

export interface LoadedProgramContext extends AnchorContextResult {
  wallet: WalletManager;
  adminKeypair: Keypair;
  connection: anchor.web3.Connection;
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
): anchor.web3.Connection =>
  connectionConfig
    ? new anchor.web3.Connection(rpcUrl, connectionConfig)
    : new anchor.web3.Connection(rpcUrl, commitment);

const toAnchorConnection = (
  connection: Connection | anchor.web3.Connection
): anchor.web3.Connection => {
  if (connection instanceof anchor.web3.Connection) {
    return connection;
  }

  const web3Connection = connection as Connection;

  return new anchor.web3.Connection(
    web3Connection.rpcEndpoint,
    web3Connection.commitment ?? "confirmed"
  );
};

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

  const resolvedRpcUrl = resolvePrimaryRpcEndpoint(
    overrides.rpcUrl ?? process.env.SOLANA_NETWORK,
    clusterApiUrl("mainnet-beta")
  );

  const connection = overrides.connection
    ? toAnchorConnection(overrides.connection)
    : resolveConnection(resolvedRpcUrl, commitment, overrides.connectionConfig);

  const wallet = resolveWallet(adminKeypair, overrides.wallet);

  const provider = new anchor.AnchorProvider(connection, wallet, providerOptions);
  anchor.setProvider(provider);

  const program = new anchor.Program(
    idl as Timba,
    provider
  ) as anchor.Program<Timba>;

  return { provider, program };
};

export const loadProgramContext = (
  options: ProgramContextLoadOptions = {}
): LoadedProgramContext => {
  const { mnemonic, wallet: walletOverride, ...anchorOverrides } = options;
  const resolvedMnemonic = mnemonic?.trim() || loadWalletMnemonic();

  const wallet =
    walletOverride ?? WalletManager.getInstance(resolvedMnemonic);
  const adminKeypair = wallet.getAdminKeypair();

  const context = createAnchorContext(adminKeypair, {
    ...anchorOverrides,
    connection: anchorOverrides.connection ?? wallet.getConnection(),
  });

  return {
    wallet,
    adminKeypair,
    program: context.program,
    provider: context.provider,
    connection: context.provider.connection,
  };
};
