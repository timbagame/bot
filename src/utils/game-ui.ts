import { copyableHtml, escapeHtml, formatCompactTokenDisplay } from "./format-amount";
import { formatDuration } from "./format-time";

export function buildGameStateUnavailableMessage(gameAddress: string, gameType: string): string {
  const normalizedType = gameType.trim().toLowerCase();
  const label =
    normalizedType === "coinflip"
      ? "Coinflip"
      : normalizedType === "giveaway"
        ? "Giveaway"
        : "Game";

  return (
    `⏳ <b>${label} pending</b>\n` +
    `Game: <code>${escapeHtml(gameAddress)}</code>\n` +
    "The game was created, but its live on-chain state is temporarily unavailable. " +
    "The bot will refresh this message automatically. Use Refresh to check again."
  );
}

export function formatPlayerAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function buildPlayerProfileLink(address: string, label?: string): string {
  const profileUrl = `https://timba.cc/players/${encodeURIComponent(address)}`;
  return `<a href="${escapeHtml(profileUrl)}">${escapeHtml(label ?? formatPlayerAddress(address))}</a>`;
}

const PROGRESS_SEGMENTS = 10;

/** Render ticket progress as a fixed-width bar, e.g. "▰▰▰▱▱▱▱▱▱▱". */
export function buildProgressBar(current: number, max: number): string {
  const segments = Math.min(PROGRESS_SEGMENTS, Math.max(1, max));
  const ratio = max > 0 ? Math.min(1, Math.max(0, current / max)) : 0;
  const filled = current > 0 && max > 0 ? Math.max(1, Math.round(ratio * segments)) : 0;
  return "▰".repeat(filled) + "▱".repeat(segments - filled);
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Build the status text line for a game based on tickets.
 * Returns a progress bar followed by a concise human-readable status.
 */
export function buildGameStatus(
  currentTickets: number,
  minTickets: number,
  maxTickets: number,
): string {
  const bar = buildProgressBar(currentTickets, maxTickets);
  if (currentTickets < minTickets) {
    return `${bar} Needs ${plural(minTickets - currentTickets, "more player")} to start`;
  }
  if (currentTickets < maxTickets) {
    return `${bar} Ready, ${plural(maxTickets - currentTickets, "spot")} left`;
  }
  return `${bar} Full, drawing soon`;
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
  return (
    `${buildGameTitle(gameTypeLabel, amountFormatted, tokenTicker, usdApproximation, explorerUrl)}\n` +
    `Creator: ${buildCreatorDisplay(creatorUsername, creatorWalletAddress)} • ${currentTickets}/${maxTickets} players`
  );
}

function buildGameTitle(
  gameTypeLabel: string,
  amountFormatted: string,
  tokenTicker: string,
  usdApproximation?: string | null,
  explorerUrl?: string | null,
): string {
  const usdSegment = usdApproximation ? ` (${escapeHtml(usdApproximation)})` : "";
  const gameExplorerIcon = explorerUrl ? `<a href="${escapeHtml(explorerUrl)}">🔎</a>` : "🔎";
  const gameLabel = `${escapeHtml(gameTypeLabel)} ${gameExplorerIcon}`;
  const amountDisplay = escapeHtml(formatCompactTokenDisplay(amountFormatted));
  const tickerDisplay = escapeHtml(tokenTicker);
  return `<b>${gameLabel} • ${amountDisplay} ${tickerDisplay}${usdSegment}</b>`;
}

function buildCreatorDisplay(creatorUsername: string, creatorWalletAddress?: string | null) {
  return creatorWalletAddress
    ? buildPlayerProfileLink(creatorWalletAddress)
    : escapeHtml(creatorUsername);
}

/**
 * Mention by account id, so Telegram notifies the user even without a username.
 */
export function buildUserMention(telegramId: string, displayName: string): string {
  return `<a href="tg://user?id=${telegramId}">${escapeHtml(displayName)}</a>`;
}

/** "Ana", "Ana and Bob", "Ana, Bob and Cid". */
export function formatNameList(names: readonly string[]): string {
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : (names[0] ?? "");
}

/**
 * Header of a challenge coinflip. `challengedDisplays` are already HTML.
 */
export function buildChallengeHeader(
  amountFormatted: string,
  tokenTicker: string,
  creatorUsername: string,
  challengedDisplays: readonly string[],
  accepted: boolean,
  usdApproximation?: string | null,
  explorerUrl?: string | null,
  creatorWalletAddress?: string | null,
): string {
  const creatorDisplay = buildCreatorDisplay(creatorUsername, creatorWalletAddress);
  return (
    `${buildGameTitle("⚔️ Challenge", amountFormatted, tokenTicker, usdApproximation, explorerUrl)}\n` +
    (accepted
      ? [creatorDisplay, ...challengedDisplays].join(" vs ")
      : `${creatorDisplay} challenged ${formatNameList(challengedDisplays)}`)
  );
}

/**
 * Status of a challenge coinflip. `waitingNames`, the challenged players who
 * have not accepted, are already HTML.
 */
export function buildChallengeStatus(accepted: boolean, waitingNames: readonly string[]): string {
  return accepted
    ? "Accepted, drawing soon"
    : `Waiting for ${formatNameList(waitingNames)} to accept`;
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
  return `\nPrize pool: ${prizeDisplay} ${safeTicker}${usdSegment}\n`;
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
