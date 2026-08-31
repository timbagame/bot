import { copyableHtml, escapeHtml, formatCompactTokenDisplay } from "./format-amount";
import { formatDuration } from "./format-time";

export function formatPlayerAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function buildPlayerProfileLink(address: string, label?: string): string {
  const profileUrl = `https://timba.cc/players/${encodeURIComponent(address)}`;
  return `<a href="${escapeHtml(profileUrl)}">${escapeHtml(label ?? formatPlayerAddress(address))}</a>`;
}

/**
 * Build the status text line for a game based on tickets.
 * Returns a concise human-readable status.
 */
export function buildGameStatus(
  currentTickets: number,
  minTickets: number,
  maxTickets: number,
): string {
  if (currentTickets < minTickets) {
    const neededForMin = minTickets - currentTickets;
    return `${neededForMin} more until minimum`;
  }
  if (currentTickets < maxTickets) {
    const neededForMax = maxTickets - currentTickets;
    return `Minimum reached, ${neededForMax} more until full`;
  }
  return "Full - starting soon!";
}

/**
 * Build the game header line with emoji, amount, ticker and creator/ticket info.
 */
export function buildGameHeader(
  gameTypeLabel: string,
  amountFormatted: string,
  tokenTicker: string,
  creatorUsername: string,
  currentTickets: number,
  maxTickets: number,
  usdApproximation?: string | null,
  explorerUrl?: string | null,
  creatorWalletAddress?: string | null,
): string {
  const usdSegment = usdApproximation ? ` (${escapeHtml(usdApproximation)})` : "";
  const gameExplorerIcon = explorerUrl ? `<a href="${escapeHtml(explorerUrl)}">🅴</a>` : "🅴";
  const gameLabel = `${escapeHtml(gameTypeLabel)} ${gameExplorerIcon}`;
  const amountDisplay = escapeHtml(formatCompactTokenDisplay(amountFormatted));
  const tickerDisplay = escapeHtml(tokenTicker);
  const creatorDisplay = creatorWalletAddress
    ? buildPlayerProfileLink(creatorWalletAddress)
    : escapeHtml(creatorUsername);
  return (
    `<b>${gameLabel} • ${amountDisplay} ${tickerDisplay}${usdSegment}</b>\n` +
    `Creator: ${creatorDisplay} • ${currentTickets}/${maxTickets} tickets`
  );
}

/**
 * Build prize line if needed, otherwise return empty string.
 */
export function buildPrizeLine(
  show: boolean,
  totalFormatted: string,
  tokenTicker: string,
  usdApproximation?: string | null,
): string {
  if (!show) return "";
  const usdSegment = usdApproximation ? ` (${escapeHtml(usdApproximation)})` : "";
  const prizeDisplay = escapeHtml(formatCompactTokenDisplay(totalFormatted));
  const safeTicker = escapeHtml(tokenTicker);
  return `\nCurrent Prize: ${prizeDisplay} ${safeTicker}${usdSegment}\n`;
}

/**
 * Winner announcement prize suffix. The amount is wrapped for Telegram tap-to-copy
 * without adding a visible hint.
 */
export function buildWinnerPrizeDetails(
  formattedAmount: string,
  tokenTicker?: string | null,
  usdApproximation?: string | null,
): string {
  const tickerSegment = tokenTicker ? ` ${tokenTicker}` : "";
  const usdSegment = usdApproximation ? ` (${usdApproximation})` : "";
  return ` Prize: ${copyableHtml(formattedAmount)}${escapeHtml(tickerSegment)}${escapeHtml(usdSegment)}`;
}

/**
 * Build participants list given usernames; returns empty when none.
 */
export type ParticipantDisplay = string | { address: string; label?: string };

export function buildParticipantsList(participants: ParticipantDisplay[]): string {
  if (!participants.length) return "";
  const lines = participants.map((participant, i) => {
    const display =
      typeof participant === "string"
        ? escapeHtml(participant)
        : buildPlayerProfileLink(participant.address, participant.label);
    return `${i + 1}. ${display}`;
  });
  return `\n${lines.join("\n")}\n`;
}

/**
 * Format remaining time until expiration as a human-friendly string.
 * Examples: "⏰ Expires in: 45m", "⏰ Expires in: 1h 20m"
 */
export function buildExpirationText(secondsRemaining: number, prefix: string = ""): string {
  return `${prefix}Expires in: ${formatDuration(secondsRemaining)}`;
}
