import { expect, test } from "bun:test";
import { buildCustomTokenPrompt } from "../src/utils/swap/prompts";

test("buildCustomTokenPrompt escapes HTML-sensitive token symbols", () => {
  const prompt = buildCustomTokenPrompt('<img src=x onerror="alert(1)">');

  expect(prompt).toContain(
    "Swapping FROM: <b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>"
  );
  expect(prompt).not.toContain('<img src=x onerror="alert(1)">');
});
