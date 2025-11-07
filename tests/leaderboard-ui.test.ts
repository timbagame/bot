import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  buildEmptyLeaderboardMessage,
  buildLeaderboardMessage,
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
      },
    ];

    const output = buildLeaderboardMessage({ chatTitle: null, players });
    expect(output).toContain("0 wins");
    expect(output).toContain("0 losses");
    expect(output).not.toContain("-5 wins");
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
