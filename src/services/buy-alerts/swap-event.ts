import { LAMPORTS_PER_SOL, WSOL_MINT } from "../../utils/constants";
import type { BuyEvent } from "./types";

export type SwapBuyInput = {
  signature: string;
  trader: string;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  inputDecimals?: number;
  inputTicker?: string;
  outputAmountRaw: string;
  outputDecimals: number;
};

export function buyEventFromSwap(input: SwapBuyInput): BuyEvent | null {
  const signature = input.signature.trim();
  const trader = input.trader.trim();
  const outputMint = input.outputMint.trim();
  if (!signature || !trader || !outputMint) {
    return null;
  }

  const decimals = Number.isFinite(input.outputDecimals) ? input.outputDecimals : 0;
  const rawOut = Number(input.outputAmountRaw);
  if (!Number.isFinite(rawOut) || rawOut <= 0) {
    return null;
  }
  const tokenAmount = decimals > 0 ? rawOut / 10 ** decimals : rawOut;
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return null;
  }

  const inputMint = input.inputMint.trim();
  const inputDecimals =
    typeof input.inputDecimals === "number" && Number.isFinite(input.inputDecimals)
      ? Math.max(0, Math.trunc(input.inputDecimals))
      : inputMint === WSOL_MINT
        ? 9
        : 0;
  const rawIn = Number(input.inputAmountRaw);
  const inputAmount = Number.isFinite(rawIn) && rawIn > 0 ? rawIn / 10 ** inputDecimals : null;
  let solAmount: number | null = null;
  if (inputMint === WSOL_MINT) {
    if (Number.isFinite(rawIn) && rawIn > 0) {
      solAmount = rawIn / LAMPORTS_PER_SOL;
    }
  }

  return {
    signature,
    mint: outputMint,
    trader,
    solAmount,
    inputAmount,
    inputSymbol: input.inputTicker?.trim() || (inputMint === WSOL_MINT ? "SOL" : null),
    tokenAmount,
    dex: "unknown",
    dexId: "jupiter",
    quoteSymbol: input.inputTicker?.trim() || (inputMint === WSOL_MINT ? "SOL" : null),
  };
}
