import { describe, expect, test } from "bun:test";
import {
  getErrorDescription,
  isChatInaccessible,
  isDuplicateContent,
  isEditProhibited,
  isMessageMissing,
  isMessageNotModified,
  isMissingEditableContent,
  shouldFallbackToReply,
} from "../src/utils/telegram-errors";

describe("telegram error helpers", () => {
  test("getErrorDescription extracts string and object messages", () => {
    expect(getErrorDescription("simple error")).toBe("simple error");
    expect(getErrorDescription({ message: "From message" })).toBe("From message");
    expect(getErrorDescription({ description: "From description" })).toBe("From description");
    expect(getErrorDescription(42)).toBe("");
  });

  test("message predicates are case-insensitive", () => {
    expect(isMessageNotModified("MESSAGE IS NOT MODIFIED"))
      .toBe(true);
    expect(isMessageMissing({ description: "Message to edit not found" })).toBe(true);
    expect(isEditProhibited("Message CAN'T be edited"))
      .toBe(true);
    expect(isChatInaccessible({ message: "Bot was blocked by the user" })).toBe(true);
    expect(isMissingEditableContent("There is no caption in the message to edit"))
      .toBe(true);
    expect(isDuplicateContent("Message with the same content already exists"))
      .toBe(true);
  });

  test("predicates return false for unrelated errors", () => {
    const unrelated = "some other error";
    expect(isMessageNotModified(unrelated)).toBe(false);
    expect(isMessageMissing(unrelated)).toBe(false);
    expect(isEditProhibited(unrelated)).toBe(false);
    expect(isChatInaccessible(unrelated)).toBe(false);
    expect(isMissingEditableContent(unrelated)).toBe(false);
    expect(isDuplicateContent(unrelated)).toBe(false);
  });

  test("shouldFallbackToReply aggregates individual predicates", () => {
    expect(shouldFallbackToReply("Message to delete not found"))
      .toBe(true);
    expect(shouldFallbackToReply("some other error"))
      .toBe(false);
  });
});
