const COMMANDS = [
  "close-orphaned-games",
  "initialize-referral-token-accounts",
  "list-pending-game-creations",
  "resolve-pending-game-creation",
  "show-swap-stats",
  "sweep-to-sol",
] as const;

export type ServiceAdminCommand = (typeof COMMANDS)[number];

export function isServiceAdminCommand(value: string): value is ServiceAdminCommand {
  return COMMANDS.includes(value as ServiceAdminCommand);
}

export function usage(): string {
  return [
    "Usage: bun run service-admin <command> [arguments]",
    "",
    "Commands:",
    "  close-orphaned-games",
    "  initialize-referral-token-accounts <mint> [mint...]",
    "  list-pending-game-creations [game_address]",
    "  resolve-pending-game-creation <game_address> --state <prepared|submitted|unknown|confirmed> --confirm --reason <evidence> [--actor <operator>]",
    "  show-swap-stats",
    "  sweep-to-sol",
  ].join("\n");
}

export async function runServiceAdmin(
  command: ServiceAdminCommand,
  args: string[] = [],
): Promise<void> {
  switch (command) {
    case "close-orphaned-games": {
      const { closeOrphanedGames } = await import("./close-orphaned-games");
      await closeOrphanedGames();
      return;
    }
    case "initialize-referral-token-accounts": {
      const { initializeReferralTokenAccounts } =
        await import("./initialize-referral-token-accounts");
      await initializeReferralTokenAccounts(args);
      return;
    }
    case "list-pending-game-creations": {
      const { listPendingGameCreations } = await import("./pending-game-creations");
      listPendingGameCreations(args[0]);
      return;
    }
    case "resolve-pending-game-creation": {
      const { resolvePendingGameCreationCommand } = await import("./pending-game-creations");
      resolvePendingGameCreationCommand(args);
      return;
    }
    case "show-swap-stats": {
      const { showSwapStats } = await import("./show-swap-stats");
      showSwapStats();
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
  if (!command || !isServiceAdminCommand(command)) {
    console.error(usage());
    process.exit(2);
  }

  runServiceAdmin(command, process.argv.slice(3)).catch((error) => {
    console.error(`Service administration failed (${command}):`, error);
    process.exit(1);
  });
}
