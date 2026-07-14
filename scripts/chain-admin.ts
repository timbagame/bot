const COMMANDS = [
  "initialize-game-tokens",
  "disable-game-tokens",
  "close-orphaned-games",
  "update-oracle",
  "update-token-min-bets",
  "withdraw-token-fees",
  "sweep-to-sol",
] as const;

export type ChainAdminCommand = (typeof COMMANDS)[number];

export function isChainAdminCommand(value: string): value is ChainAdminCommand {
  return COMMANDS.includes(value as ChainAdminCommand);
}

export function usage(): string {
  return [
    "Usage: bun run chain-admin <command>",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c}`),
  ].join("\n");
}

export async function runChainAdmin(command: ChainAdminCommand): Promise<void> {
  switch (command) {
    case "initialize-game-tokens": {
      const { initializeGameToken } = await import("./initialize-game-token");
      await initializeGameToken();
      return;
    }
    case "disable-game-tokens": {
      const { disableGameTokens } = await import("./disable-game-tokens");
      await disableGameTokens();
      return;
    }
    case "close-orphaned-games": {
      const { closeOrphanedGames } = await import("./close-orphaned-games");
      await closeOrphanedGames();
      return;
    }
    case "update-oracle": {
      const { updateOracle } = await import("./update-oracle");
      await updateOracle();
      return;
    }
    case "update-token-min-bets": {
      const { updateTokenMinBets } = await import("./update-token-min-bets");
      await updateTokenMinBets();
      return;
    }
    case "withdraw-token-fees": {
      const { withdrawTokenFees } = await import("./withdraw-token-fees");
      await withdrawTokenFees();
      return;
    }
    case "sweep-to-sol": {
      const { sweepToSol } = await import("./sweep-to-sol");
      await sweepToSol();
    }
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  if (!command || !isChainAdminCommand(command)) {
    console.error(usage());
    process.exit(2);
  }

  runChainAdmin(command).catch((error) => {
    console.error(`Chain administration failed (${command}):`, error);
    process.exit(1);
  });
}
