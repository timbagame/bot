import { describe, expect, it } from "bun:test";
import { getContractIdl, resolveContractVersion } from "../src/utils/contract-idl";

describe("contract ABI compatibility", () => {
  it("accepts both supported versions", () => {
    expect(resolveContractVersion("0.1.3")).toBe("0.1.3");
    expect(resolveContractVersion("0.2.0")).toBe("0.2.0");
  });

  it("loads the exact 0.1.3 ABI", () => {
    const idl = getContractIdl("0.1.3");
    const game = idl.types.find((value: any) => value.name === "Game");
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participant_hashes",
      type: { vec: "u64" },
    });
    const complete = idl.instructions.find((value: any) => value.name === "complete_game");
    expect(complete.accounts.some((value: any) => value.name === "system_program")).toBe(true);
    expect(idl.errors).toContainEqual({
      code: 7402,
      name: "UnsupportedTokenProgram",
      msg: "Token program unsupported",
    });
  });

  it("loads the 0.2.0 participant layout", () => {
    const idl = getContractIdl("0.2.0");
    const game = idl.types.find((value: any) => value.name === "Game");
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participants",
      type: { vec: "pubkey" },
    });
  });
});
