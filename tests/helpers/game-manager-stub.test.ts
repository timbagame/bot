import { test, expect } from "bun:test";
import { makeDbStub } from "./game-manager";

test("game manager stub maintains normalized username cache", () => {
  const db = makeDbStub({ usernameToId: { cached: "111" } });
  expect(db.findTelegramIdByUsername("@Cached")).toBe("111");

  db.saveUsernameMapping("Cached", "222");
  expect(db.findTelegramIdByNormalizedUsername("cached")).toBe("222");
  expect(db.findTelegramIdByUsername("cached")).toBe("222");
});

test("game manager stub handles normalized username collisions", () => {
  const db = makeDbStub({ usernameToId: { "@Collide": "111" } });
  expect(db.findTelegramIdByUsername("@Collide")).toBe("111");

  db.saveUsernameMapping("COLLIDE", "222");
  expect(db.findTelegramIdByNormalizedUsername("collide")).toBe("222");
  expect(db.findTelegramIdByUsername("COLLIDE")).toBe("222");
});
