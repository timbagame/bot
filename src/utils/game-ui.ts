import { escapeHtml, formatCompactTokenDisplay } from "./format-amount";

/**
 * Build the status text line for a game based on tickets.
 * Returns a concise human-readable status.
 */
export function buildGameStatus(
  currentTickets: number,
  minTickets: number,
  maxTickets: number
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
  usdApproximation?: string | null
): string {
  const usdSegment = usdApproximation
    ? ` (${escapeHtml(usdApproximation)})`
    : "";
  const amountDisplay = escapeHtml(
    formatCompactTokenDisplay(amountFormatted)
  );
  const tickerDisplay = escapeHtml(tokenTicker);
  const creatorDisplay = escapeHtml(creatorUsername);
  return (
    `<b>${gameTypeLabel} • ${amountDisplay} ${tickerDisplay}${usdSegment}</b>\n` +
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
  usdApproximation?: string | null
): string {
  if (!show) return "";
  const usdSegment = usdApproximation
    ? ` (${escapeHtml(usdApproximation)})`
    : "";
  const prizeDisplay = escapeHtml(
    formatCompactTokenDisplay(totalFormatted)
  );
  const safeTicker = escapeHtml(tokenTicker);
  return `\nCurrent Prize: ${prizeDisplay} ${safeTicker}${usdSegment}\n`;
}

/**
 * Build participants list given usernames; returns empty when none.
 */
export function buildParticipantsList(usernames: string[]): string {
  if (!usernames.length) return "";
  const lines = usernames.map((u, i) => `${i + 1}. ${escapeHtml(u)}`);
  return `\n${lines.join("\n")}\n`;
}

/**
 * Format remaining time until expiration as a human-friendly string.
 * Examples: "⏰ Expires in: 45m", "⏰ Expires in: 1h 20m"
 */
export function buildExpirationText(
  secondsRemaining: number,
  prefix: string = ""
): string {
  return `${prefix}Expires in: ${formatDuration(secondsRemaining)}`;
}

/**
 * Format a duration in seconds to a compact string.
 * Examples: "10s", "45m", "1h 20m", "3d"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(0, Math.floor(seconds))}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    if (remainingMinutes > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (remainingHours > 0) {
    return `${days}d ${remainingHours}h`;
  }
  return `${days}d`;
}
