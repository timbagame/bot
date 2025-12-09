import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  buildEmptyLeaderboardMessage,
  buildLeaderboardMessage,
  buildEmptyGlobalLeaderboardMessage,
  buildGlobalLeaderboardMessage,
  formatNetUsd,
  sanitizeLeaderboardDisplayName,
  type LeaderboardPlayerDisplay,
} from "../src/utils/leaderboard-ui";
import { escapeHtml } from "../src/utils/format-amount";

type LeaderboardPlayerSeed = {
  displayName: string;
  winRate: number;
  wins: number;
  losses: number;
  totalGames: number;
  gamesCreated: number;
  gamesJoined: number;
};

describe("leaderboard UI rendering", () => {
  test("empty leaderboard message mirrors leaderboard layout", () => {
    const message = buildEmptyLeaderboardMessage();
    expect(message).toContain("Leaderboard");
    expect(message).toContain("Top players in this group");
    expect(message).toContain("play a coinflip");
  });

  test("buildLeaderboardMessage escapes chat title and highlights leaders", () => {
    const players: LeaderboardPlayerDisplay[] = [
      {
        telegramId: "1",
        displayName: "<champion>",
        totalGames: 50,
        wins: 30,
        losses: 20,
        winRate: 60,
        gamesCreated: 10,
        gamesJoined: 40,
        totalVolume: 0,
        netWonUsd: 150.50,
      },
      {
        telegramId: "2",
        displayName: "Runner & Up",
        totalGames: 80,
        wins: 50,
        losses: 30,
        winRate: 62.5,
        gamesCreated: 5,
        gamesJoined: 75,
        totalVolume: 0,
        netWonUsd: 75.25,
      },
      {
        telegramId: "3",
        displayName: "Volume Master",
        totalGames: 90,
        wins: 45,
        losses: 45,
        winRate: 50,
        gamesCreated: 60,
        gamesJoined: 30,
        totalVolume: 0,
        netWonUsd: -25.00,
      },
    ];

    const output = buildLeaderboardMessage({
      chatTitle: "Elite <Guild>",
      players,
    });

    expect(output).toContain(escapeHtml("Elite <Guild>"));
    expect(output).toContain("🥇");
    expect(output).toMatch(/Highlights/);
    expect(output).toContain("Runner &amp; Up");
    expect(output).toContain("Most games played");
  });

  test("win rate formatting clamps invalid inputs", () => {
    const players: LeaderboardPlayerDisplay[] = [
      {
        telegramId: "1",
        displayName: "No Games",
        totalGames: 0,
        wins: -5,
        losses: -10,
        winRate: -100,
        gamesCreated: 0,
        gamesJoined: 0,
        totalVolume: 0,
        netWonUsd: 0,
      },
      {
        telegramId: "2",
        displayName: "Only Losses",
        totalGames: 10,
        wins: 0,
        losses: 10,
        winRate: 0,
        gamesCreated: 0,
        gamesJoined: 10,
        totalVolume: 0,
        netWonUsd: -50,
      },
    ];

    const output = buildLeaderboardMessage({ chatTitle: null, players });
    expect(output).toContain("0 wins");
    expect(output).toContain("0 losses");
    expect(output).not.toContain("-5 wins");
  });

  test("sanitizeLeaderboardDisplayName obfuscates mentions", () => {
    const sanitized = sanitizeLeaderboardDisplayName("@someone");
    expect(sanitized).toContain("@\u2060");
  });

  test("sanitizeLeaderboardDisplayName falls back for blank names", () => {
    const sanitized = sanitizeLeaderboardDisplayName("   ".repeat(1));
    expect(sanitized).toBe("Player");
    const rendered = buildLeaderboardMessage({
      chatTitle: null,
      players: [
        {
          telegramId: "42",
          displayName: "   ",
          totalGames: 1,
          wins: 1,
          losses: 0,
          winRate: 100,
          gamesCreated: 0,
          gamesJoined: 1,
          totalVolume: 0,
          netWonUsd: 10,
        },
      ],
    });
    expect(rendered).toContain("<b>Player</b>");
  });

  test("player names are always HTML escaped (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
           fc.array(
             fc.record<LeaderboardPlayerSeed>({
               displayName: fc.string({ minLength: 1, maxLength: 20 }),
               winRate: fc.float({ min: 0, max: 100 }),
               wins: fc.integer({ min: 0, max: 100 }),
               losses: fc.integer({ min: 0, max: 100 }),
               totalGames: fc.integer({ min: 0, max: 200 }),
               gamesCreated: fc.integer({ min: 0, max: 200 }),
               gamesJoined: fc.integer({ min: 0, max: 200 }),
             }),
             { minLength: 1, maxLength: 5 }
           ),
           async (entries: LeaderboardPlayerSeed[]) => {
             const players: LeaderboardPlayerDisplay[] = entries.map(
               (entry: LeaderboardPlayerSeed, index: number) => ({
                 telegramId: `${index}`,
                 displayName: entry.displayName,
                 totalGames: entry.totalGames,
                 wins: entry.wins,
                 losses: entry.losses,
                 winRate: entry.winRate,
                 gamesCreated: entry.gamesCreated,
                 gamesJoined: entry.gamesJoined,
                 totalVolume: 0,
                 netWonUsd: 0,
               })
             );

             const rendered = buildLeaderboardMessage({ chatTitle: "Guild", players });
          for (const player of players) {
            const escaped = escapeHtml(sanitizeLeaderboardDisplayName(player.displayName));
            expect(rendered).toContain(`<b>${escaped}</b>`);
          }
        }
      ),
      { seed: 4242, numRuns: 30 }
    );
  });
});

describe("formatNetUsd", () => {
  test("formats positive values with + prefix", () => {
    expect(formatNetUsd(100.50)).toBe("+$100.50");
    expect(formatNetUsd(1234.56)).toBe("+$1.2k");
    expect(formatNetUsd(0.0025)).toBe("+$0.0025");
  });

  test("formats negative values with - prefix", () => {
    expect(formatNetUsd(-50.00)).toBe("-$50.00");
    expect(formatNetUsd(-2500)).toBe("-$2.5k");
    expect(formatNetUsd(-0.005)).toBe("-$0.0050");
  });

  test("formats zero as $0", () => {
    expect(formatNetUsd(0)).toBe("$0");
  });

  test("handles non-finite values as $0", () => {
    expect(formatNetUsd(NaN)).toBe("$0");
    expect(formatNetUsd(Infinity)).toBe("$0");
    expect(formatNetUsd(-Infinity)).toBe("$0");
  });
});

describe("global leaderboard UI rendering", () => {
  test("empty global leaderboard message shows correct heading", () => {
    const message = buildEmptyGlobalLeaderboardMessage();
    expect(message).toContain("Global Leaderboard");
    expect(message).toContain("Top players across all groups");
    expect(message).toContain("play a coinflip");
    expect(message).not.toContain("in this group");
  });

  test("buildGlobalLeaderboardMessage shows global header and legend", () => {
    const players: LeaderboardPlayerDisplay[] = [
      {
        telegramId: "1",
        displayName: "GlobalChamp",
        totalGames: 100,
        wins: 60,
        losses: 40,
        winRate: 60,
        gamesCreated: 30,
        gamesJoined: 70,
        totalVolume: 0,
        netWonUsd: 500.00,
      },
    ];

    const output = buildGlobalLeaderboardMessage({ players });

    expect(output).toContain("Global Leaderboard");
    expect(output).toContain("Top players across all groups");
    expect(output).toContain("🥇");
    expect(output).toContain("GlobalChamp");
  });

  test("buildGlobalLeaderboardMessage uses allPlayers for highlights", () => {
    const displayedPlayers: LeaderboardPlayerDisplay[] = [
      {
        telegramId: "1",
        displayName: "TopEarner",
        totalGames: 10,
        wins: 8,
        losses: 2,
        winRate: 80,
        gamesCreated: 5,
        gamesJoined: 5,
        totalVolume: 0,
        netWonUsd: 1000.00,
      },
    ];

    const allPlayers: LeaderboardPlayerDisplay[] = [
      ...displayedPlayers,
      {
        telegramId: "2",
        displayName: "MostGamesPlayer",
        totalGames: 200,
        wins: 100,
        losses: 100,
        winRate: 50,
        gamesCreated: 50,
        gamesJoined: 150,
        totalVolume: 0,
        netWonUsd: 0,
      },
    ];

    const output = buildGlobalLeaderboardMessage({
      players: displayedPlayers,
      allPlayers,
    });

    expect(output).toContain("Global Leaderboard");
    expect(output).toContain("Highlights");
    expect(output).toContain("Most games played");
    expect(output).toContain("MostGamesPlayer");
  });
});
