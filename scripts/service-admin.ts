const COMMANDS = [
  "close-orphaned-games",
  "initialize-referral-token-accounts",
  "withdraw-token-fees",
  "sweep-to-sol",
] as const;

export type ServiceAdminCommand = (typeof COMMANDS)[number];

export function isServiceAdminCommand(value: string): value is ServiceAdminCommand {
  return COMMANDS.includes(value as ServiceAdminCommand);
}

export function usage(): string {
  return [
    "Usage: bun run service-admin <command>",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command}`),
  ].join("\n");
}

export async function runServiceAdmin(command: ServiceAdminCommand): Promise<void> {
  switch (command) {
    case "close-orphaned-games": {
      const { closeOrphanedGames } = await import("./close-orphaned-games");
      await closeOrphanedGames();
      return;
    }
    case "initialize-referral-token-accounts": {
      const { initializeReferralTokenAccounts } =
        await import("./initialize-referral-token-accounts");
      await initializeReferralTokenAccounts();
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
  if (!command || !isServiceAdminCommand(command)) {
    console.error(usage());
    process.exit(2);
  }

  runServiceAdmin(command).catch((error) => {
    console.error(`Service administration failed (${command}):`, error);
    process.exit(1);
  });
}
