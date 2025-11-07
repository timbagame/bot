import { escapeHtml } from "./format-amount";

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
};

type BuildLeaderboardMessageArgs = {
  chatTitle?: string | null;
  players: LeaderboardPlayerDisplay[];
};

const MEDALS = ["🥇", "🥈", "🥉"] as const;

const ZERO_WIDTH_WORD_JOINER = "\u2060";

export const sanitizeLeaderboardDisplayName = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.includes("@")) {
    return trimmed;
  }

  return trimmed.replace(/@+/g, (match) => `${match}${ZERO_WIDTH_WORD_JOINER}`);
};

export const buildEmptyLeaderboardMessage = (): string =>
  [
    "🏆 <b>Leaderboard</b>",
    "Top players in this group",
    "No statistics available yet - play a coinflip to appear here.",
  ].join("\n\n");

export const buildLeaderboardMessage = ({ chatTitle, players }: BuildLeaderboardMessageArgs): string => {
  const heading = chatTitle
    ? `🏆 <b>${escapeHtml(chatTitle.trim())}</b>`
    : "🏆 <b>Leaderboard</b>";

  const legend = "Top players in this group";

  const rows = players
    .map((player, index) => formatLeaderboardRow(player, index))
    .join("\n\n");

  const highlights = buildLeaderboardHighlights(players);

  return [heading, legend, rows, highlights].filter(Boolean).join("\n\n");
};

const formatDisplayName = (value: string): string => {
  const safeValue = sanitizeLeaderboardDisplayName(value);
  return `<b>${escapeHtml(safeValue)}</b>`;
};

const formatLeaderboardRow = (player: LeaderboardPlayerDisplay, position: number): string => {
  const rank = `${position + 1}.`.padStart(3, " ");
  const medal = MEDALS[position] ?? "";
  const displayName = formatDisplayName(player.displayName);

  const detailSegments = [
    formatWinCount(player.wins),
    formatLossCount(player.losses),
    `${formatWinRate(player.winRate)}% win rate`,
  ];

  const detailLine = detailSegments.join(" • ");

  const medalPart = medal ? `${medal} ` : "";
  const headerLine = `${rank} ${medalPart}${displayName}`.trim();

  return `${headerLine}\n${detailLine}`;
};

const buildLeaderboardHighlights = (players: LeaderboardPlayerDisplay[]): string | null => {
  if (players.length < 2) {
    return null;
  }

  const champion = players[0]!;

  const highestWinRate = players.reduce((best, current) => {
    return current.winRate > best.winRate ? current : best;
  }, champion);

  const mostGames = players.reduce((best, current) => {
    return current.totalGames > best.totalGames ? current : best;
  }, champion);

  const highlights: string[] = [];

  if (highestWinRate.telegramId !== champion.telegramId) {
    highlights.push(
      `• Best win rate: ${formatDisplayName(highestWinRate.displayName)} (${formatWinRate(highestWinRate.winRate)}%)`
    );
  }

  if (mostGames.telegramId !== champion.telegramId) {
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
