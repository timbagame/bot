export const TEST_GAME_ADDRESS = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";
export const TEST_OPERATOR_ADDRESS = "11111111111111111111111111111111";
export const TEST_SIGNATURE = "1".repeat(64);

export function oracleResponse(payload: Record<string, unknown>) {
  return {
    timestamp: "2026-08-25T12:00:00.000Z",
    service: {
      name: "oracle-api",
      version: "1.0.0",
      environment: "test",
      uptime: 1,
    },
    success: true,
    ...payload,
  };
}

export const completeOracleStats = {
  totalSecrets: 10,
  usedSecrets: 5,
  pendingGames: 2,
  completedGames: 8,
  cancelledGames: 0,
  eventListening: false,
  activeListeners: 0,
};
