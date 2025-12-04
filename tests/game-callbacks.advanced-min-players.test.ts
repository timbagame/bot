import { describe, expect, test } from "bun:test";

import { createGameCallbacksModule } from "../src/handlers/game-callbacks";

const module = createGameCallbacksModule({} as any);

describe("advanced minimum players prompt", () => {
  test("caps the displayed range at the selected player count", () => {
    const { prompt, maxPlayers } =
      module.__test_buildAdvancedMinPlayersPrompt("coinflip", 4);

    expect(prompt).toContain("Range: 2-4");
    expect(maxPlayers).toBe(4);
  });
});
