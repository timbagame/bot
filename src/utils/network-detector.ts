/**
 * Network detection utility
 */
import { DEFAULT_MAINNET_ENDPOINT, resolvePrimaryRpcEndpoint } from "./rpc-endpoints";

export type SolanaNetwork = "mainnet" | "devnet" | "testnet" | "localnet";

const JUPITER_NETWORKS = new Set<SolanaNetwork>(["mainnet"]);

const NETWORK_DISPLAY_NAMES: Record<SolanaNetwork, string> = {
  mainnet: "Mainnet",
  devnet: "Devnet",
  testnet: "Testnet",
  localnet: "Localnet",
};

function networkFromRpcHost(rpcUrl: string): SolanaNetwork | undefined {
  let hostname: string;
  try {
    const url = new URL(rpcUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return "localnet";
  }
  // Provider hostnames commonly use a cluster label, such as solana-devnet.
  // Credentials, paths and queries never determine the cluster.
  const labels = hostname.split(/[.-]/);
  if (labels.includes("devnet")) return "devnet";
  if (labels.includes("testnet")) return "testnet";
  if (labels.includes("mainnet") || hostname === "api.solana.com") return "mainnet";
  return undefined;
}

export class NetworkDetector {
  /**
   * Detect network based on RPC URL
   */
  static detectNetwork(rpcUrl: string): SolanaNetwork {
    return networkFromRpcHost(rpcUrl) ?? "mainnet";
  }

  /**
   * Resolve a user-friendly display name directly from an RPC URL.
   * Returns "Custom Network" when the RPC cannot be associated with
   * one of the known clusters.
   */
  static getDisplayNameFromRpc(rpcUrl: string | undefined | null): string {
    if (!rpcUrl) {
      return this.getNetworkDisplayName(this.getCurrentNetwork());
    }

    const network = networkFromRpcHost(rpcUrl);
    return network ? this.getNetworkDisplayName(network) : "Custom Network";
  }

  /**
   * Check if network supports Jupiter
   */
  static supportsJupiter(network: SolanaNetwork): boolean {
    return JUPITER_NETWORKS.has(network);
  }

  /**
   * Get network display name
   */
  static getNetworkDisplayName(network: SolanaNetwork): string {
    return NETWORK_DISPLAY_NAMES[network];
  }

  /**
   * Get current network from environment
   */
  static getCurrentNetwork(): SolanaNetwork {
    const rpcUrl = resolvePrimaryRpcEndpoint(process.env.SOLANA_NETWORK, DEFAULT_MAINNET_ENDPOINT);
    return this.detectNetwork(rpcUrl);
  }

  /**
   * Build a Solscan transaction URL respecting the configured network.
   * Returns null when Solscan cannot display the network (e.g. localnet).
   */
  static buildSolscanTxUrl(
    signature: string | undefined | null,
    networkOverride?: string | null,
  ): string | null {
    return this.buildSolscanResourceUrl("tx", signature, networkOverride);
  }

  /**
   * Build a Solscan account URL respecting the configured network.
   * Returns null when Solscan cannot display the network (e.g. localnet).
   */
  static buildSolscanAccountUrl(
    address: string | undefined | null,
    networkOverride?: string | null,
  ): string | null {
    return this.buildSolscanResourceUrl("account", address, networkOverride);
  }

  /**
   * Build a Solscan token URL respecting the configured network.
   * Returns null when Solscan cannot display the network (e.g. localnet).
   */
  static buildSolscanTokenUrl(
    mint: string | undefined | null,
    networkOverride?: string | null,
  ): string | null {
    return this.buildSolscanResourceUrl("token", mint, networkOverride);
  }

  private static buildSolscanResourceUrl(
    resource: "tx" | "account" | "token",
    value: string | undefined | null,
    networkOverride?: string | null,
  ): string | null {
    if (!value) return null;

    const network = this.resolveNetworkInput(networkOverride) ?? this.getCurrentNetwork();
    if (network === "localnet") {
      return null;
    }

    const encodedValue = resource === "account" ? encodeURIComponent(value) : value;
    const baseUrl = `https://solscan.io/${resource}/${encodedValue}`;

    if (network === "mainnet") {
      return baseUrl;
    }

    return `${baseUrl}?cluster=${network}`;
  }

  public static resolveNetworkInput(input?: string | null): SolanaNetwork | undefined {
    if (!input) {
      return undefined;
    }

    const normalized = input.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
      return this.detectNetwork(normalized);
    }

    if (normalized === "mainnet" || normalized === "mainnet-beta") {
      return "mainnet";
    }
    if (normalized === "devnet") {
      return "devnet";
    }
    if (normalized === "testnet") {
      return "testnet";
    }
    if (normalized === "localnet" || normalized === "localhost") {
      return "localnet";
    }

    return undefined;
  }
}

export type TransactionLinkFormat = "html" | "markdown";

export interface TransactionLinkOptions {
  signature?: string | null;
  networkOverride?: string | null;
  label?: string;
  linkText?: string;
  format?: TransactionLinkFormat;
  fallbackToSignature?: boolean;
}

export interface TransactionLinkResult {
  message: string | null;
  solscanUrl: string | null;
  previewDisabled: boolean;
  displaySignature: string | null;
}

export function buildTransactionLinkMessage({
  signature,
  networkOverride,
  label,
  linkText,
  format = "html",
  fallbackToSignature = false,
}: TransactionLinkOptions): TransactionLinkResult {
  if (!signature) {
    return {
      message: null,
      solscanUrl: null,
      previewDisabled: false,
      displaySignature: null,
    };
  }

  const solscanUrl = NetworkDetector.buildSolscanTxUrl(signature, networkOverride);
  const normalizedLabel = label ?? "";

  if (solscanUrl) {
    const anchorText = linkText ?? signature;
    const message =
      format === "markdown"
        ? `${normalizedLabel}[${anchorText}](${solscanUrl})`
        : `${normalizedLabel}<a href="${solscanUrl}">${anchorText}</a>`;

    return {
      message,
      solscanUrl,
      previewDisabled: true,
      displaySignature: signature,
    };
  }

  if (!fallbackToSignature) {
    return {
      message: null,
      solscanUrl: null,
      previewDisabled: false,
      displaySignature: signature,
    };
  }

  return {
    message: `${normalizedLabel}${signature}`,
    solscanUrl: null,
    previewDisabled: false,
    displaySignature: signature,
  };
}
