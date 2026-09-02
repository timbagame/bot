import { describe, expect, it } from "bun:test";
import { contractIdl } from "../src/utils/contract-idl";

describe("contract ABI", () => {
  it("uses the v0.3 game-vault account lists", () => {
    const accounts = (instructionName: string) => {
      const instruction = contractIdl.instructions.find(
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

  it("does not expose v0.2 GameToken administration", () => {
    const instructionNames = contractIdl.instructions.map(({ name }: { name: string }) => name);
    expect(instructionNames).not.toContain("withdraw_token_fee");
    expect(instructionNames).not.toContain("initialize_game_token");
    expect(contractIdl.accounts.map(({ name }: { name: string }) => name)).not.toContain(
      "GameToken",
    );
  });

  it("loads the canonical participant layout", () => {
    const game = contractIdl.types.find((value: any) => value.name === "Game") as any;
    expect(game.type.fields.at(-1)).toMatchObject({
      name: "participants",
      type: { vec: "pubkey" },
    });
  });
});
