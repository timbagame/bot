import { describe, expect, test } from "bun:test";
import { getContractIdl, parseContractVersion } from "../src/utils/contract-idl";

describe("contract ABI", () => {
  test("uses the v0.3 game-vault account lists", () => {
    const v030 = getContractIdl("0.3.0");
    const accounts = (instructionName: string) => {
      const instruction = v030.instructions.find(
        ({ name }: { name: string }) => name === instructionName,
      );
      if (!instruction) throw new Error(`Missing ${instructionName}`);
      return instruction.accounts.map(({ name }: { name: string }) => name);
    };

    expect(accounts("initialize_game")).toEqual([
      "game",
      "creator",
      "oracle",
      "oracle_operator",
      "game_vault_ctx",
      "creator_token_account",
      "system_program",
    ]);
    expect(accounts("join_game")).toEqual([
      "game",
      "player",
      "oracle_operator",
      "game_vault_ctx",
      "player_token_account",
      "oracle",
    ]);
    expect(accounts("unjoin_game")).toEqual([
      "game",
      "player",
      "authority",
      "oracle",
      "game_vault_ctx",
      "player_token_account",
    ]);
    expect(accounts("close_game")).toEqual([
      "game",
      "creator",
      "oracle",
      "game_vault_ctx",
      "creator_token_account",
    ]);
  });

  test("keeps the v0.2 GameToken account lists", () => {
    const v020 = getContractIdl("0.2.0");
    const accounts = (instructionName: string) => {
      const instruction = v020.instructions.find(
        ({ name }: { name: string }) => name === instructionName,
      );
      if (!instruction) throw new Error(`Missing ${instructionName}`);
      return instruction.accounts.map(({ name }: { name: string }) => name);
    };

    expect(accounts("initialize_game")).toContain("game_token_ctx");
    expect(accounts("join_game")).toContain("game_token_ctx");
    expect(accounts("unjoin_game")).toContain("game_token_ctx");
    expect(accounts("close_game")).toContain("game_token_ctx");
    expect(v020.accounts.map(({ name }: { name: string }) => name)).toContain("GameToken");
  });

  test("defaults deployment selection to v0.2.0", () => {
    expect(parseContractVersion(undefined)).toBe("0.2.0");
    expect(parseContractVersion("0.3.0")).toBe("0.3.0");
    expect(() => parseContractVersion("0.4.0")).toThrow(
      "CONTRACT_VERSION must be one of 0.2.0, 0.3.0",
    );
  });

  test("does not expose v0.2 GameToken administration", () => {
    const v030 = getContractIdl("0.3.0");
    const instructionNames = v030.instructions.map(({ name }: { name: string }) => name);
    expect(instructionNames).not.toContain("withdraw_token_fee");
    expect(instructionNames).not.toContain("initialize_game_token");
    expect(v030.accounts.map(({ name }: { name: string }) => name)).not.toContain("GameToken");
  });

  test("loads the canonical participant layout", () => {
    const game = getContractIdl("0.3.0").types.find((value: any) => value.name === "Game") as any;
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participants",
      type: { vec: "pubkey" },
    });
  });
});
