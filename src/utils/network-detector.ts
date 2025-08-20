/**
 * Network detection utility
 */

export type SolanaNetwork = 'mainnet' | 'devnet' | 'testnet' | 'localnet';

export class NetworkDetector {
  
  /**
   * Detect network based on RPC URL
   */
  static detectNetwork(rpcUrl: string): SolanaNetwork {
    const url = rpcUrl.toLowerCase();
    
    if (url.includes('devnet')) {
      return 'devnet';
    }
    
    if (url.includes('testnet')) {
      return 'testnet';
    }
    
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      return 'localnet';
    }
    
    // Default to mainnet for mainnet-beta and other URLs
    return 'mainnet';
  }

  /**
   * Check if network supports Jupiter
   */
  static supportsJupiter(network: SolanaNetwork): boolean {
    return network === 'mainnet';
  }

  /**
   * Check if network supports simulation
   */
  static supportsSimulation(network: SolanaNetwork): boolean {
    return network === 'devnet' || network === 'testnet' || network === 'localnet';
  }

  /**
   * Get network display name
   */
  static getNetworkDisplayName(network: SolanaNetwork): string {
    const names = {
      'mainnet': 'Mainnet',
      'devnet': 'Devnet', 
      'testnet': 'Testnet',
      'localnet': 'Localnet'
    };
    return names[network];
  }

  /**
   * Get current network from environment
   */
  static getCurrentNetwork(): SolanaNetwork {
    const rpcUrl = process.env.SOLANA_NETWORK || 'https://api.mainnet-beta.solana.com';
    return this.detectNetwork(rpcUrl);
  }
}