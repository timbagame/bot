import { escapeHtml } from "../format-amount";
import { INPUT_TIMEOUT_HINT } from "../constants";

export const buildCustomTokenPrompt = (fromToken: string): string => {
  const safeFromToken = escapeHtml(fromToken);

  const lines = [
    "🔍 <b>Custom Token</b>",
    "",
    `Swapping FROM: <b>${safeFromToken}</b>`,
    "",
    "Reply to this message with the token mint address or symbol.",
    "",
    "<b>Examples:</b>",
    "• <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code> (USDC)",
    "• <code>BONK</code>",
    "",
    INPUT_TIMEOUT_HINT,
  ];

  return lines.join("\n");
};
