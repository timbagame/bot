export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

export const parseSolanaRpcUrls = (
  raw: string | undefined | null
): string[] => {
  if (!raw) {
    return [DEFAULT_RPC_URL];
  }

  const segments = raw
    .split(/[\s,]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.length > 0 ? segments : [DEFAULT_RPC_URL];
};

export const getPrimarySolanaRpcUrl = (): string => {
  const [primary] = parseSolanaRpcUrls(process.env.SOLANA_NETWORK);
  return primary ?? DEFAULT_RPC_URL;
};
