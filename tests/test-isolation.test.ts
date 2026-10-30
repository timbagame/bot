import { expect, test } from "bun:test";
import { join } from "node:path";
import packageJson from "../package.json";

// File order differs between machines, so a stub one file leaves behind must not reach
// another. The test script has to isolate files; this runs it on a file that leaks a stub
// followed by one that would see it.
test("the test script isolates test files from each other", () => {
  const [command, ...args] = packageJson.scripts.test.split(" ");
  const fixtures = join(import.meta.dir, "fixtures", "isolation");
  const run = Bun.spawnSync(
    [
      command === "bun" ? process.execPath : command!,
      ...args,
      join(fixtures, "a-leak.ts"),
      join(fixtures, "b-check.ts"),
    ],
    { cwd: join(import.meta.dir, ".."), env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const output = run.stdout.toString() + run.stderr.toString();
  expect(output).toContain(" 2 pass");
  expect(run.exitCode).toBe(0);
});
