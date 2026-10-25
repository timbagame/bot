import { expect, test } from "bun:test";
import { decodeProgramEventLog } from "../src/utils/program-event-parser";

// GameCompleted discriminator followed by far fewer bytes than the layout needs.
const GAME_COMPLETED = Buffer.from([103, 26, 106, 108, 240, 191, 179, 120]);

test("a truncated known event falls through to the fallback decoder", () => {
  const log = Buffer.concat([GAME_COMPLETED, Buffer.alloc(10)]).toString("base64");
  const seen: string[] = [];

  const event = decodeProgramEventLog(log, (entry) => {
    seen.push(entry);
    return { name: "Fallback", data: {} };
  });

  expect(seen).toEqual([log]);
  expect(event).toEqual({ name: "Fallback", data: {} });
});

test("a truncated known event without a fallback decodes to null", () => {
  const log = Buffer.concat([GAME_COMPLETED, Buffer.alloc(10)]).toString("base64");
  expect(decodeProgramEventLog(log)).toBeNull();
});
