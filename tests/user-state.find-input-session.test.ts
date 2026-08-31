import { afterEach, expect, test } from "bun:test";
import { clearAllInputSessions, findInputSession, setInputSession } from "../src/utils/user-state";

afterEach(() => {
  clearAllInputSessions();
});

test("findInputSession returns the newest matching prompt", () => {
  setInputSession("chat_old", {
    type: "chat_defaults",
    chatId: 10,
    initiatorId: "20",
    setting: "video_coinflip",
  });
  setInputSession("chat_other_user", {
    type: "chat_defaults",
    chatId: 10,
    initiatorId: "30",
    setting: "video_buy_alerts",
  });
  setInputSession("chat_new", {
    type: "chat_defaults",
    chatId: 10,
    initiatorId: "20",
    setting: "video_buy_alerts",
  });

  const found = findInputSession(
    (_key, session) =>
      session.type === "chat_defaults" &&
      session.chatId === 10 &&
      session.initiatorId === "20" &&
      typeof session["setting"] === "string" &&
      session["setting"].startsWith("video_"),
  );

  expect(found?.key).toBe("chat_new");
  expect(found?.session["setting"]).toBe("video_buy_alerts");
});
