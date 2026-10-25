import { expect, test } from "bun:test";
import { buildGameStateUnavailableMessage } from "../src/utils/game-ui";

test("pending-state message labels known game types and falls back to a generic game", () => {
  expect(buildGameStateUnavailableMessage("Addr1", " CoinFlip ")).toContain(
    "<b>Coinflip pending</b>",
  );
  expect(buildGameStateUnavailableMessage("Addr1", "giveaway")).toContain(
    "<b>Giveaway pending</b>",
  );
  const generic = buildGameStateUnavailableMessage("Addr<1>", "lottery");
  expect(generic).toContain("<b>Game pending</b>");
  expect(generic).toContain("<code>Addr&lt;1&gt;</code>");
});
