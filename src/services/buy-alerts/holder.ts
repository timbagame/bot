export type TokenBalanceLike = {
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    uiAmount?: number | null;
    amount?: string | null;
  };
};

export function isNewHolderFromBalances(args: {
  mint: string;
  owner: string;
  preTokenBalances?: TokenBalanceLike[] | null;
}): boolean | null {
  const mint = args.mint.trim();
  const owner = args.owner.trim();
  if (!mint || !owner || !args.preTokenBalances) {
    return null;
  }

  const pre = args.preTokenBalances.find(
    (row) => row.mint?.trim() === mint && row.owner?.trim() === owner,
  );
  if (!pre) {
    return true;
  }

  const uiAmount = pre.uiTokenAmount?.uiAmount;
  if (typeof uiAmount === "number" && Number.isFinite(uiAmount)) {
    return uiAmount <= 0;
  }

  const raw = pre.uiTokenAmount?.amount?.trim();
  if (raw != null && raw !== "") {
    try {
      return BigInt(raw) <= 0n;
    } catch {
      return null;
    }
  }

  return true;
}

export async function detectNewHolder(
  connection: {
    getParsedTransaction: (
      signature: string,
      options: { maxSupportedTransactionVersion: number; commitment: "confirmed" },
    ) => Promise<{
      meta?: {
        preTokenBalances?: TokenBalanceLike[] | null;
      } | null;
    } | null>;
  },
  event: { signature: string; mint: string; trader: string },
): Promise<boolean | null> {
  const signature = event.signature.trim();
  if (!signature || signature.startsWith("test-")) {
    return null;
  }

  try {
    const parsed = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    return isNewHolderFromBalances({
      mint: event.mint,
      owner: event.trader,
      preTokenBalances: parsed?.meta?.preTokenBalances ?? null,
    });
  } catch (error) {
    console.warn(`Unable to detect new holder for ${signature}:`, error);
    return null;
  }
}
