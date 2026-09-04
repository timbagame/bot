import { Keypair } from "#solana";
import { FeeBudgetManager } from "../../src/utils/fee-budget";
import { wallet } from "../../src/bot";

export const stubWalletConnection = (lamports: number) => {
  const original = wallet.getConnection;
  (wallet as any).getConnection = () => ({ getBalance: async () => lamports });
  return () => {
    (wallet as any).getConnection = original;
  };
};

export const stubOperatorKeypair = () => {
  const original = (wallet as any).getOperatorKeypair;
  const kp = Keypair.generate();
  (wallet as any).getOperatorKeypair = () => kp;
  return () => {
    (wallet as any).getOperatorKeypair = original;
  };
};

export const stubFeeBudgetWrapZero = () => {
  const fb = FeeBudgetManager.getInstance(wallet.getConnection());
  const originalWrap = (fb as any).getWrapFeeBufferLamports;
  const originalDefault = (fb as any).getDefaultWrapFeeBufferLamports;
  (fb as any).getWrapFeeBufferLamports = async () => 0;
  (fb as any).getDefaultWrapFeeBufferLamports = () => 0;
  return () => {
    (fb as any).getWrapFeeBufferLamports = originalWrap;
    (fb as any).getDefaultWrapFeeBufferLamports = originalDefault;
  };
};

export type JupiterFetchHandler = (
  url: string,
  callCount: number,
  init?: RequestInit,
) => Promise<Response>;

export const createJupiterFetchStub = (
  capture: { url?: string; urls?: string[] },
  handler: JupiterFetchHandler,
) => {
  let callCount = 0;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    capture.url = url;
    if (capture.urls) {
      capture.urls.push(url);
    }
    callCount += 1;
    return handler(url, callCount, init);
  };
};
