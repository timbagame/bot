const MAX_TOKEN_SYMBOL_GRAPHEMES = 10;

export function abbreviateMint(mint?: string): string {
  const normalized = mint?.trim();
  if (!normalized) return "TOKEN";
  if (normalized.length <= 10) return normalized;
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

export function sanitizeTokenSymbol(symbol: unknown, mint?: string): string {
  const normalized = String(symbol ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!normalized) return abbreviateMint(mint);

  const graphemes = Array.from(
    new Intl.Segmenter("en", { granularity: "grapheme" }).segment(normalized),
    ({ segment }) => segment,
  );
  if (graphemes.length <= MAX_TOKEN_SYMBOL_GRAPHEMES) return normalized;
  return `${graphemes.slice(0, MAX_TOKEN_SYMBOL_GRAPHEMES - 1).join("")}…`;
}

export function resolveTokenDisplaySymbols(
  tokens: ReadonlyArray<{ ticker: string; mint?: string }>,
): string[] {
  const sanitized = tokens.map((token) => sanitizeTokenSymbol(token.ticker, token.mint));
  const counts = new Map<string, number>();
  for (const symbol of sanitized) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);

  return sanitized.map((symbol, index) => {
    if ((counts.get(symbol) ?? 0) <= 1) return symbol;
    return `${symbol} · ${abbreviateMint(tokens[index]?.mint)}`;
  });
}
