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
  static buildSolscanTxUrl(signature: string | undefined | null): string | null {
    if (!signature) return null;
    const network = this.getCurrentNetwork();
    if (network === "localnet") return null;

    const baseUrl = `https://solscan.io/tx/${signature}`;
    if (network === "mainnet") return baseUrl;

    if (network === "devnet" || network === "testnet") {
      return `${baseUrl}?cluster=${network}`;
    }

    return baseUrl;
  }
}
