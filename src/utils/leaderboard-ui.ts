import { escapeHtml } from "./format-amount";
import { sanitizeTelegramDisplayNameWithoutMention } from "./telegram-display";

export type LeaderboardPlayerDisplay = {
  telegramId: string;
  displayName: string;
  totalGames: number;
  wins: number;
  losses: number;
  winRate: number;
  gamesCreated: number;
  gamesJoined: number;
  totalVolume: number;
  /** Net winnings in USD (positive = profit, negative = loss) */
  netWonUsd: number;
};

type BuildLeaderboardMessageArgs = {
  chatTitle?: string | null;
  players: LeaderboardPlayerDisplay[];
  /** Optional: all players for highlights calculation (defaults to players if not provided) */
  allPlayers?: LeaderboardPlayerDisplay[];
};

const MEDALS = ["🥇", "🥈", "🥉"] as const;

export const sanitizeLeaderboardDisplayName = (
  value: string | null | undefined
): string => sanitizeTelegramDisplayNameWithoutMention(value);

export const buildEmptyLeaderboardMessage = (): string =>
  [
    "🏆 <b>Leaderboard</b>",
    "Top players in this group (last 30 days)",
    "No statistics available yet - play a coinflip to appear here.",
  ].join("\n\n");

export const buildEmptyGlobalLeaderboardMessage = (): string =>
  [
    "🌐 <b>Global Leaderboard</b>",
    "Top players across all groups (last 30 days)",
    "No statistics available yet - play a coinflip to appear here.",
  ].join("\n\n");

export const buildGlobalLeaderboardMessage = ({ players, allPlayers }: Omit<BuildLeaderboardMessageArgs, "chatTitle">): string => {
  const heading = "🌐 <b>Global Leaderboard</b>";
  const legend = "Top players across all groups (last 30 days)";

  const rows = players
    .map((player, index) => formatLeaderboardRow(player, index))
    .join("\n\n");

  const highlightsSource = allPlayers ?? players;
  const champion = players[0];
  const highlights = buildLeaderboardHighlights(highlightsSource, champion);

  return [heading, legend, rows, highlights].filter(Boolean).join("\n\n");
};

export const buildLeaderboardMessage = ({ chatTitle, players, allPlayers }: BuildLeaderboardMessageArgs): string => {
  const heading = chatTitle
    ? `🏆 <b>${escapeHtml(chatTitle.trim())}</b>`
    : "🏆 <b>Leaderboard</b>";

  const legend = "Top players in this group (last 30 days)";

  const rows = players
    .map((player, index) => formatLeaderboardRow(player, index))
    .join("\n\n");

  // Use allPlayers for highlights if provided, otherwise use displayed players
  const highlightsSource = allPlayers ?? players;
  const champion = players[0]; // Champion is from displayed players
  const highlights = buildLeaderboardHighlights(highlightsSource, champion);

  return [heading, legend, rows, highlights].filter(Boolean).join("\n\n");
};

const formatDisplayName = (value: string): string => {
  const safeValue = sanitizeTelegramDisplayNameWithoutMention(value);
  return `<b>${escapeHtml(safeValue)}</b>`;
};

const formatLeaderboardRow = (player: LeaderboardPlayerDisplay, position: number): string => {
  const rank = `${position + 1}.`.padStart(3, " ");
  const medal = MEDALS[position] ?? "";
  const displayName = formatDisplayName(player.displayName);
  const netUsdFormatted = formatNetUsd(player.netWonUsd);

  const detailSegments = [
    netUsdFormatted,
    formatWinCount(player.wins),
    formatLossCount(player.losses),
  ];

  const detailLine = detailSegments.join(" • ");

  const medalPart = medal ? `${medal} ` : "";
  const headerLine = `${rank} ${medalPart}${displayName}`.trim();

  return `${headerLine}\n${detailLine}`;
};

const buildLeaderboardHighlights = (
  players: LeaderboardPlayerDisplay[],
  champion?: LeaderboardPlayerDisplay
): string | null => {
  if (players.length < 2) {
    return null;
  }

  // Use provided champion or default to first player
  const leaderboardChampion = champion ?? players[0]!;

  const highestWinRate = players.reduce((best, current) => {
    return current.winRate > best.winRate ? current : best;
  }, leaderboardChampion);

  const mostGames = players.reduce((best, current) => {
    return current.totalGames > best.totalGames ? current : best;
  }, leaderboardChampion);

  const highlights: string[] = [];

  if (highestWinRate.telegramId !== leaderboardChampion.telegramId) {
    highlights.push(
      `• Best win rate: ${formatDisplayName(highestWinRate.displayName)} (${formatWinRate(highestWinRate.winRate)}%)`
    );
  }

  if (mostGames.telegramId !== leaderboardChampion.telegramId) {
    highlights.push(
      `• Most games played: ${formatDisplayName(mostGames.displayName)} (${mostGames.totalGames})`
    );
  }

  if (highlights.length === 0) {
    return null;
  }

  return `<b>Highlights</b>\n${highlights.join("\n")}`;
};

const formatWinRate = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }

  const rounded = Number(value.toFixed(1));
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
};

const formatWinCount = (wins: number): string => {
  const safeWins = Math.max(0, wins);
  return `${safeWins} ${safeWins === 1 ? "win" : "wins"}`;
};

const formatLossCount = (losses: number): string => {
  const safeLosses = Math.max(0, losses);
  return `${safeLosses} ${safeLosses === 1 ? "loss" : "losses"}`;
};

export const formatNetUsd = (value: number): string => {
  if (!Number.isFinite(value) || value === 0) {
    return "$0";
  }

  const absValue = Math.abs(value);
  const formatted = absValue >= 1000
    ? `$${(absValue / 1000).toFixed(1)}k`
    : absValue >= 1
    ? `$${absValue.toFixed(2)}`
    : `$${absValue.toFixed(4)}`;

  return value > 0 ? `+${formatted}` : `-${formatted}`;
};
