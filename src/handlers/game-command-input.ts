/** Existing Telegram grammar: omitted amount opens setup; an amount creates directly. */
export function parseGameCommandInput(args: readonly string[]) {
  const values = args.filter(Boolean);
  const first = values[0];
  const isAmount = (value: string | undefined) =>
    Boolean(value && /^\$?(?:\d+(?:\.\d*)?|\.\d+)\$?$/.test(value));
  if (!first) return { mode: "menu" as const, token: undefined, amount: undefined };
  if (values.length === 1 && !isAmount(first))
    return { mode: "menu" as const, token: first, amount: undefined };
  const second = values[1];
  const token =
    second && !isAmount(second) && !["USD", "PRIVATE", "PUBLIC"].includes(second.toUpperCase())
      ? second
      : undefined;
  return { mode: "direct" as const, token, amount: first };
}
