import { PublicKey } from "#solana";
import type { TimbaProgram } from "./timba-program";
import {
  decodeProgramEvent,
  getTrustedProgramData,
  EVENT_DISCRIMINATORS,
  type ProgramEvent as SharedEvent,
} from "@timbagame/protocol/contracts/events";

export const PLAYER_UNJOINED_DISCRIMINATOR = Buffer.from(EVENT_DISCRIMINATORS.PlayerUnjoined);
export type ProgramEvent = { name: string; data: Record<string, unknown> };
function adapt(event: SharedEvent): ProgramEvent {
  const data: Record<string, unknown> = { ...event.data };
  for (const field of [
    "gameKey",
    "creator",
    "winner",
    "player",
    "tokenMint",
    "operator",
    "movedParticipant",
  ]) {
    if (typeof data[field] === "string") data[field] = new PublicKey(data[field] as string);
  }
  if (event.name === "GameInitialized") data["gameType"] = { [event.data["gameType"]]: {} };
  return { name: event.name, data };
}
export function decodeLegacyPlayerUnjoined(logBase64: string): ProgramEvent | null {
  const bytes = Buffer.from(logBase64, "base64");
  if (bytes.length !== 104) return null;
  const event = decodeProgramEvent(bytes);
  return event?.name === "PlayerUnjoined" ? adapt(event) : null;
}
export function decodeProgramEventLog(
  logBase64: string,
  decodeFallback?: (log: string) => ProgramEvent | null,
): ProgramEvent | null {
  try {
    const event = decodeProgramEvent(Buffer.from(logBase64, "base64"));
    if (event) return adapt(event);
  } catch {
    /* Keep the legacy caller's fallback behavior. */
  }
  try {
    return decodeFallback?.(logBase64) ?? null;
  } catch {
    return null;
  }
}
export function parseProgramEventLogs(
  programId: PublicKey,
  logs: readonly string[],
): ProgramEvent[] {
  return getTrustedProgramData(logs, programId.toBase58()).flatMap((bytes) => {
    try {
      const event = decodeProgramEvent(bytes);
      return event ? [adapt(event)] : [];
    } catch {
      return [];
    }
  });
}
export function parseProgramEventsFromTransaction(
  program: Pick<TimbaProgram, "programId">,
  logs: readonly string[] | null | undefined,
): ProgramEvent[] {
  return parseProgramEventLogs(program.programId, logs ?? []);
}
