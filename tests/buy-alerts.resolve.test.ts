import { expect, test } from "bun:test";
import {
  resolveBuyAlertToken,
  formatMinSolLabel,
  parseMinSolInput,
} from "../src/services/buy-alerts/resolve";

const botDefault = { tokenMint: "bot-mint", tokenTicker: "TIMBA" };

test("resolveBuyAlertToken prefers an explicit chat override", () => {
  expect(
    resolveBuyAlertToken(
      {
        chat_id: 1,
        enabled: true,
        token_mint: "override-mint",
        token_ticker: "MAGAIBA",
        min_sol_lamports: null,
        media_file_id: null,
        media_type: null,
        set_by_telegram_id: "1",
        updated_at: 1,
      },
      { token_mint: "chat-mint", token_ticker: "CHAT" },
      botDefault,
    ),
  ).toEqual({ mint: "override-mint", ticker: "MAGAIBA" });
});

test("resolveBuyAlertToken falls back to chat default then bot default", () => {
  expect(
    resolveBuyAlertToken(null, { token_mint: "chat-mint", token_ticker: "CHAT" }, botDefault),
  ).toEqual({ mint: "chat-mint", ticker: "CHAT" });

  expect(resolveBuyAlertToken(null, null, botDefault)).toEqual({
    mint: "bot-mint",
    ticker: "TIMBA",
  });
});

test("formatMinSolLabel describes the configured floor", () => {
  expect(formatMinSolLabel(null)).toBe("Off");
  expect(formatMinSolLabel(50_000_000)).toBe("0.05 SOL");
  expect(formatMinSolLabel(100_000_000)).toBe("0.1 SOL");
  expect(formatMinSolLabel(1_000_000_000)).toBe("1 SOL");
});

test("parseMinSolInput accepts custom amounts and treats 0 as off", () => {
  expect(parseMinSolInput("0.05")).toEqual({ ok: true, minSolLamports: 50_000_000 });
  expect(parseMinSolInput("0,25 SOL")).toEqual({ ok: true, minSolLamports: 250_000_000 });
  expect(parseMinSolInput("2")).toEqual({ ok: true, minSolLamports: 2_000_000_000 });
  expect(parseMinSolInput("off")).toEqual({ ok: true, minSolLamports: null });
  expect(parseMinSolInput("0")).toEqual({ ok: true, minSolLamports: null });
  expect(parseMinSolInput("")).toEqual({ ok: false });
  expect(parseMinSolInput("nope")).toEqual({ ok: false });
  expect(parseMinSolInput("0.0000001")).toEqual({ ok: false });
  expect(parseMinSolInput("999999")).toEqual({ ok: false });
});
