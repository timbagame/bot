/**
 * Map an RPC URL to a user-friendly network label
 */
export function getNetworkFromRPC(rpcUrl: string): string {
  const url = rpcUrl.toLowerCase();
  if (url.includes("devnet")) return "Devnet";
  if (url.includes("testnet")) return "Testnet";
  if (url.includes("mainnet") || url.includes("api.solana.com")) return "Mainnet";
  return "Custom Network";
}

