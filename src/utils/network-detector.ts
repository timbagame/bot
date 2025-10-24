/**
 * Network detection utility
 */

export type SolanaNetwork = "mainnet" | "devnet" | "testnet" | "localnet";

const JUPITER_NETWORKS = new Set<SolanaNetwork>(["mainnet"]);

const NETWORK_DISPLAY_NAMES: Record<SolanaNetwork, string> = {
  mainnet: "Mainnet",
  devnet: "Devnet",
  testnet: "Testnet",
  localnet: "Localnet",
};

export class NetworkDetector {
  /**
   * Detect network based on RPC URL
   */
  static detectNetwork(rpcUrl: string): SolanaNetwork {
    const url = rpcUrl.toLowerCase();

    if (url.includes("devnet")) {
      return "devnet";
    }

    if (url.includes("testnet")) {
      return "testnet";
    }

    if (url.includes("localhost") || url.includes("127.0.0.1")) {
      return "localnet";
    }

    // Default to mainnet for mainnet-beta and other URLs
    return "mainnet";
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

    const url = rpcUrl.toLowerCase();
    const network = this.detectNetwork(url);

    const isRecognized =
      url.includes("devnet") ||
      url.includes("testnet") ||
      url.includes("mainnet") ||
      url.includes("api.solana.com") ||
      url.includes("localhost") ||
      url.includes("127.0.0.1");

    if (!isRecognized) {
      return "Custom Network";
    }

    return this.getNetworkDisplayName(network);
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
    const rpcUrl =
      process.env.SOLANA_NETWORK || "https://api.mainnet-beta.solana.com";
    return this.detectNetwork(rpcUrl);
  }

  /**
   * Build a Solscan transaction URL respecting the configured network.
   * Returns null when Solscan cannot display the network (e.g. localnet).
   */
  static buildSolscanTxUrl(
    signature: string | undefined | null,
    networkOverride?: string | null
  ): string | null {
    return this.buildSolscanResourceUrl("tx", signature, networkOverride);
  }

  /**
   * Build a Solscan account URL respecting the configured network.
   * Returns null when Solscan cannot display the network (e.g. localnet).
   */
  static buildSolscanAccountUrl(
    address: string | undefined | null,
    networkOverride?: string | null
  ): string | null {
    return this.buildSolscanResourceUrl("account", address, networkOverride);
  }

  /**
   * Build a Solscan token URL respecting the configured network.
   * Returns null when Solscan cannot display the network (e.g. localnet).
   */
  static buildSolscanTokenUrl(
    mint: string | undefined | null,
    networkOverride?: string | null
  ): string | null {
    return this.buildSolscanResourceUrl("token", mint, networkOverride);
  }

  private static buildSolscanResourceUrl(
    resource: "tx" | "account" | "token",
    value: string | undefined | null,
    networkOverride?: string | null
  ): string | null {
    if (!value) return null;

    const network =
      this.resolveNetworkInput(networkOverride) ?? this.getCurrentNetwork();
    if (network === "localnet") {
      return null;
    }

    const encodedValue =
      resource === "account" ? encodeURIComponent(value) : value;
    const baseUrl = `https://solscan.io/${resource}/${encodedValue}`;

    if (network === "mainnet") {
      return baseUrl;
    }

    if (network === "devnet" || network === "testnet") {
      return `${baseUrl}?cluster=${network}`;
    }

    return baseUrl;
  }

  private static resolveNetworkInput(
    input?: string | null
  ): SolanaNetwork | undefined {
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
