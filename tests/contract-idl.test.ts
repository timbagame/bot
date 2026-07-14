import { describe, expect, it } from "bun:test";
import {
  createLegacyIdl,
  resolveContractVersion,
} from "../src/utils/contract-idl";

describe("contract ABI compatibility", () => {
  it("defaults to 0.1.3 and accepts the upgrade target", () => {
    expect(resolveContractVersion(undefined)).toBe("0.1.3");
    expect(resolveContractVersion("0.2.0")).toBe("0.2.0");
  });

  it("uses hashes and legacy system accounts for 0.1.3", () => {
    const idl = createLegacyIdl();
    const game = idl.types.find((value: any) => value.name === "Game");
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participant_hashes",
      type: { vec: "u64" },
    });
    const complete = idl.instructions.find(
      (value: any) => value.name === "complete_game",
    );
    expect(
      complete.accounts.some((value: any) => value.name === "system_program"),
    ).toBe(true);
  });
});
