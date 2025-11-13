import { describe, expect, test } from "bun:test";
import { collectErrorLogs } from "../src/utils/errors";

describe("collectErrorLogs", () => {
  test("handles cyclic error causes without infinite recursion", () => {
    const cyclic: any = { logs: ["root"] };
    cyclic.cause = cyclic;

    const logs = collectErrorLogs(cyclic);
    expect(logs).toEqual(["root"]);
  });
});
