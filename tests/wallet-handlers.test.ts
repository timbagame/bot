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
});

