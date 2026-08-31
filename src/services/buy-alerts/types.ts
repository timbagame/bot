export type BuyDex = "pump" | "raydium" | "unknown";

export type BuyEvent = {
  signature: string;
  mint: string;
  trader: string;
  solAmount: number | null;
  inputAmount?: number | null;
  inputSymbol?: string | null;
  tokenAmount: number;
  dex: BuyDex;
  dexId?: string | null;
  quoteSymbol?: string | null;
  newHolder?: boolean | null;
};

export type PairStats = {
  priceUsd: number | null;
  marketCapUsd: number | null;
  priceChangeH24: number | null;
  url: string | null;
  dexId: string | null;
  quoteSymbol: string | null;
  pairAddress: string | null;
  tokenName: string | null;
};

export type ResolvedBuyAlertToken = {
  mint: string;
  ticker: string;
};

export type BuyFeed = {
  setMints: (mints: readonly string[]) => void;
  onTrade: (handler: (event: BuyEvent) => void) => void;
  stop: () => void;
};
