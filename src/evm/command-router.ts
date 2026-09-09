/** Route only new commands. Existing callbacks carry their original chain identity. */
export function routeNetworkCommand(text: string, username: string, network: "solana" | "evm") {
  const parsed = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+(.*))?$/is.exec(text);
  if (
    network !== "evm" ||
    !parsed ||
    (parsed[2] && parsed[2].toLowerCase() !== username.toLowerCase())
  )
    return null;
  const name = parsed[1]!.toLowerCase();
  const command =
    (
      {
        cf: "ecf",
        coinflip: "ecf",
        ga: "egiveaway",
        giveaway: "egiveaway",
        balance: "evm",
        wallet: "evm",
        invite: "einvite",
        withdraw: "ewithdraw",
        wh: "ewithdraw",
      } as Record<string, string>
    )[name] ?? (name === "start" && !parsed[3] ? "evm" : undefined);
  if (!command) return null;
  let args = parsed[3] ?? "";
  if (command === "ewithdraw") {
    const [address, amount, symbol = "ETH"] = args.trim().split(/\s+/);
    args = `${symbol} ${amount ?? ""} ${address ?? ""}`;
  }
  return { command, args };
}
