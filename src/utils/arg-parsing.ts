export type InferPlayersResult =
  { ok: true; value: number; source: "default" | "arg" } | { ok: false; error: string };

/**
 * Infer max players from command args in a robust, index-based way.
 *
 * Examples (amountArgIndex = 1):
 * - ["/cf", "10"] -> default
 * - ["/cf", "10", "3"] -> players=3
 * - ["/cf", "10", "TIMBA"] -> default (token specified)
 * - ["/cf", "10", "TIMBA", "4"] -> players=4
 */
export function inferMaxPlayers(
  args: string[],
  amountArgIndex: number,
  tokenWasSpecified: boolean,
  defaultPlayers: number,
  minPlayers: number,
  maxPlayers: number,
): InferPlayersResult {
  // Determine expected index for a players argument
  const playersIndex = tokenWasSpecified
    ? amountArgIndex + 2 // amount, token, players
    : amountArgIndex + 1; // amount, players

  if (args.length > playersIndex) {
    const candidate = args[playersIndex];
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      // Only accept pure integer strings (no decimals, no suffixes like "4x")
      if (/^\d+$/.test(trimmed)) {
        const maybe = Number(trimmed);
        if (maybe < minPlayers || maybe > maxPlayers) {
          return { ok: false, error: `Players must be between ${minPlayers}-${maxPlayers}.` };
        }
        return { ok: true, value: maybe, source: "arg" };
      }
    }
  }

  if (defaultPlayers < minPlayers || defaultPlayers > maxPlayers) {
    return {
      ok: false,
      error: `Players must be between ${minPlayers}-${maxPlayers}.`,
    };
  }

  return { ok: true, value: defaultPlayers, source: "default" };
}
