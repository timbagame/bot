import { describe, test, expect } from "bun:test";
import { onMainWallet, onWalletRefresh, onWalletSettings } from "../src/handlers/wallet";

function makeCtx() {
  const calls: any[] = [];
  const ctx: any = {
    from: { id: 1 },
    answerCallbackQuery: async (...args: any[]) => { calls.push(["answer", ...args]); return { ok: true }; },
    editMessageText: async (...args: any[]) => { calls.push(["editText", ...args]); throw new Error("fail"); },
    reply: async (...args: any[]) => { calls.push(["reply", ...args]); return { ok: true }; },
    __calls: calls,
  };
  return ctx;
}

describe("wallet handlers", () => {
  test("onMainWallet shows UI and answers callback", async () => {
    const ctx: any = makeCtx();
    let shown = 0;
    const deps = {
      showWalletUI: async () => { shown++; },
      clearWalletCache: (_: any) => {},
      createSettingsKeyboard: () => ({ rows: [] } as any),
    };
    await onMainWallet(ctx, deps);
    const calls = ctx.__calls;
    expect(shown).toBe(1);
    expect(calls[0][0]).toBe("answer");
  });

  test("onWalletRefresh clears cache and shows UI", async () => {
    const ctx: any = makeCtx();
    let cleared: any = null;
    let shown = 0;
    const deps = {
      showWalletUI: async () => { shown++; },
      clearWalletCache: (id: any) => { cleared = id; },
      createSettingsKeyboard: () => ({ rows: [] } as any),
    };
    await onWalletRefresh(ctx, deps);
    expect(cleared).toBe(1n);
    expect(shown).toBe(1);
  });

  test("onWalletSettings edits or replies and answers callback", async () => {
    const ctx: any = makeCtx();
    ctx.callbackQuery = { message: { message_id: 99, chat: { id: 1 } } };
    const deps = {
      showWalletUI: async () => {},
      clearWalletCache: (_: any) => {},
      createSettingsKeyboard: () => ({ rows: [] } as any),
    };
    await onWalletSettings(ctx, deps);
    const calls = ctx.__calls;
    // editText attempt then reply fallback, then answer
    expect(calls[0][0]).toBe("editText");
    expect(calls[1][0]).toBe("reply");
    expect(calls[2][0]).toBe("answer");
  });

  test("onMainWallet reports errors and answers callback", async () => {
    const ctx: any = makeCtx();
    const deps = {
      showWalletUI: async () => {
        throw new Error("boom");
      },
      clearWalletCache: (_: any) => {},
      createSettingsKeyboard: () => ({ rows: [] } as any),
    };
    await onMainWallet(ctx, deps);
    const answer = ctx.__calls.find((c: any[]) => c[0] === "answer");
    expect(String(answer[1])).toContain("Error loading wallet menu");
  });

  test("onWalletRefresh catches errors and responds", async () => {
    const ctx: any = makeCtx();
    const deps = {
      showWalletUI: async () => {
        throw new Error("refresh-fail");
      },
      clearWalletCache: (_: any) => {},
      createSettingsKeyboard: () => ({ rows: [] } as any),
    };
    await onWalletRefresh(ctx, deps);
    const answer = ctx.__calls.find((c: any[]) => c[0] === "answer");
    expect(String(answer[1])).toContain("Error refreshing wallet");
  });

  test("onWalletSettings surfaces keyboard creation errors", async () => {
    const ctx: any = makeCtx();
    const deps = {
      showWalletUI: async () => {},
      clearWalletCache: (_: any) => {},
      createSettingsKeyboard: () => {
        throw new Error("keyboard fail");
      },
    };
    await onWalletSettings(ctx, deps);
    const answer = ctx.__calls.find((c: any[]) => c[0] === "answer");
    expect(String(answer[1])).toContain("Error loading settings");
  });
});
