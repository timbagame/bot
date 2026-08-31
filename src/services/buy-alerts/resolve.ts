import { LAMPORTS_PER_SOL } from "../../utils/constants";
import type { ChatBuyAlertConfig } from "../../types";
import type { ResolvedBuyAlertToken } from "./types";

export const MIN_BUY_ALERT_SOL = 0.001;
export const MAX_BUY_ALERT_SOL = 10_000;

export type ParsedMinSol = { ok: true; minSolLamports: number | null } | { ok: false };

export function resolveBuyAlertToken(
  config: ChatBuyAlertConfig | null | undefined,
  chatDefault: { token_mint: string; token_ticker: string } | null | undefined,
  botDefault: { tokenMint: string; tokenTicker: string },
): ResolvedBuyAlertToken {
  const overrideMint = config?.token_mint?.trim();
  if (overrideMint) {
    return {
      mint: overrideMint,
      ticker: config?.token_ticker?.trim() || "TOKEN",
    };
  }

  if (chatDefault?.token_mint) {
    return {
      mint: chatDefault.token_mint,
      ticker: chatDefault.token_ticker,
    };
  }

  return {
    mint: botDefault.tokenMint,
    ticker: botDefault.tokenTicker,
  };
}

export function formatMinSolLabel(minSolLamports: number | null | undefined): string {
  if (minSolLamports == null || minSolLamports <= 0) {
    return "Off";
  }

  const formatted = (minSolLamports / LAMPORTS_PER_SOL)
    .toFixed(9)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `${formatted} SOL`;
}

export function parseMinSolInput(raw: string): ParsedMinSol {
  const trimmed = raw.trim().toLowerCase().replace(/,/g, ".");
  if (!trimmed) {
    return { ok: false };
  }
  if (trimmed === "off" || trimmed === "none") {
    return { ok: true, minSolLamports: null };
  }

  const numeric = trimmed.replace(/\s*sol\s*$/i, "").trim();
  const sol = Number(numeric);
  if (!Number.isFinite(sol) || sol < 0) {
    return { ok: false };
  }
  if (sol === 0) {
    return { ok: true, minSolLamports: null };
  }
  if (sol < MIN_BUY_ALERT_SOL || sol > MAX_BUY_ALERT_SOL) {
    return { ok: false };
  }

  return { ok: true, minSolLamports: Math.round(sol * LAMPORTS_PER_SOL) };
}
