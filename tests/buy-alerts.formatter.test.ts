import { expect, test } from "bun:test";
import {
  formatBuyAlertMessage,
  dexLabel,
  dexMark,
  formatMarketCapUsd,
} from "../src/services/buy-alerts/formatter";
import type { BuyEvent } from "../src/services/buy-alerts/types";

const event: BuyEvent = {
  signature: "5Ksig",
  mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
  trader: "AYhV2U111111111111111111111111111111Coqy",
  solAmount: 1.8998,
  tokenAmount: 1_270_000,
  dex: "raydium",
  newHolder: true,
};

test("formatBuyAlertMessage matches the MAGAIBA buy-bot layout", () => {
  const originalNetwork = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";

  try {
    const text = formatBuyAlertMessage({
      event,
      ticker: "MAGAIBA",
      pair: {
        priceUsd: 0.000152,
        marketCapUsd: 132_750,
        priceChangeH24: 14.44,
        url: "https://dexscreener.com/solana/pair",
        dexId: "raydium",
        quoteSymbol: "SOL",
        pairAddress: "pair-1",
        tokenName: "🔮 MAGAIBA Oracle 🔮",
      },
      solPriceUsd: 101.41,
    });

    expect(text).toContain("<b>💰 BUY - 🔮 MAGAIBA Oracle 🔮</b>");
    expect(text).not.toContain("👛");
    expect(text).not.toContain("☀️");
    expect(text).not.toContain("🆕");
    expect(text).toContain("AYhV2U...Coqy");
    expect(text).toContain("Spent: <code>1.8998</code> SOL ($192.66)");
    expect(text).toContain("Got: <code>1.27M</code> MAGAIBA");
    expect(text).toContain("DEX: ⚡ Raydium AMM SOL");
    expect(text).not.toContain("💊");
    expect(text).toContain("Price: $0.000152");
    expect(text).toContain("[Txn]");
    expect(text).toContain("New Holder!");
    expect(text).toContain("📈 MarketCap: $132.75K");
    expect(text).toContain("24h: +14.44%");
    expect(text).toContain("🔗 ");
    expect(text).toContain("DexScreener");
    expect(text).not.toContain("Tap to copy");
    expect(text).toContain("https://solscan.io/tx/5Ksig");
  } finally {
    if (originalNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalNetwork;
    }
  }
});

test("formatBuyAlertMessage escapes attacker-controlled ticker text", () => {
  const text = formatBuyAlertMessage({
    event: { ...event, newHolder: false },
    ticker: "TIMBA<script>",
    pair: null,
    solPriceUsd: null,
  });

  expect(text).toContain("TIMBA&lt;script&gt;");
  expect(text).not.toContain("<script>");
  expect(text).not.toContain("New Holder");
});

test("formatBuyAlertMessage shows the actual input token when SOL value is unknown", () => {
  const text = formatBuyAlertMessage({
    event: {
      ...event,
      solAmount: null,
      inputAmount: 2.5,
      inputSymbol: "USDC<script>",
    },
    ticker: "TIMBA",
    pair: null,
    solPriceUsd: 100,
  });

  expect(text).toContain("Spent: <code>2.5</code> USDC&lt;script&gt;");
  expect(text).not.toContain("Spent: <code>0</code> SOL");
});

test("dexLabel maps explicit venue metadata and preserves unknown venues", () => {
  expect(dexLabel("pump", "raydium")).toBe("Raydium AMM");
  expect(dexLabel("unknown", "pumpswap")).toBe("PumpSwap");
  expect(dexLabel("pump", null)).toBe("Pump.fun");
  expect(dexLabel("unknown", null)).toBe("Unknown");
});

test("formatBuyAlertMessage prefers the event venue over the market-data pair", () => {
  const text = formatBuyAlertMessage({
    event: {
      ...event,
      dex: "pump",
      dexId: "pumpfun",
      quoteSymbol: "USDC",
    },
    ticker: "TIMBA",
    pair: {
      priceUsd: 1,
      marketCapUsd: 1,
      priceChangeH24: 0,
      url: null,
      dexId: "raydium",
      quoteSymbol: "SOL",
      pairAddress: "unrelated-top-pair",
      tokenName: "TIMBA",
    },
  });

  expect(text).toContain("DEX: 💊 Pump.fun USDC");
  expect(text).not.toContain("Raydium AMM");
});

test("dexMark uses a venue mark for each major Solana DEX", () => {
  expect(dexMark("pump", "pumpfun")).toBe("💊");
  expect(dexMark("raydium", "raydium")).toBe("⚡");
  expect(dexMark("unknown", "meteora")).toBe("☄️");
  expect(dexMark("unknown", "orca")).toBe("🐋");
  expect(dexMark("unknown", "jupiter")).toBe("🪐");
  expect(dexMark("unknown", "lifinity")).toBe("📊");
});

test("pump venues get a pill on the DEX line", () => {
  const text = formatBuyAlertMessage({
    event: { ...event, dex: "pump", newHolder: false },
    ticker: "TIMBA",
    pair: {
      priceUsd: 0.00000522,
      marketCapUsd: 5_220,
      priceChangeH24: -0.37,
      url: "https://dexscreener.com/solana/byxahgga9u8ruerpbfqq7n97q35u9msch3emqvxvt5dd",
      dexId: "pumpfun",
      quoteSymbol: "SOL",
      pairAddress: "BYxaHGga9U8rUERpbFqQ7N97Q35u9MScH3EmqvXvt5dD",
      tokenName: "TIMBA",
    },
    solPriceUsd: 101.43,
  });

  expect(text).toContain("DEX: 💊 Pump.fun SOL");
  expect(text).toContain("24h: -0.37%");
  expect(text).toContain(
    "https://dexscreener.com/solana/byxahgga9u8ruerpbfqq7n97q35u9msch3emqvxvt5dd",
  );
});

test("formatMarketCapUsd uses MAGAIBA-style suffixes", () => {
  expect(formatMarketCapUsd(132_750)).toBe("132.75K");
  expect(formatMarketCapUsd(5_238)).toBe("5.24K");
  expect(formatMarketCapUsd(1_500_000)).toBe("1.5M");
});
