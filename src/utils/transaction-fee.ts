import type { Connection } from "#solana";

export async function getConfirmedTransactionFeeLamports(
  connection: Pick<Connection, "getTransaction">,
  signature: string | undefined,
): Promise<number | null> {
  if (!signature || typeof connection.getTransaction !== "function") return null;

  try {
    const transaction = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const fee = transaction?.meta?.fee;
    return typeof fee === "number" && Number.isSafeInteger(fee) && fee >= 0 ? fee : null;
  } catch (error) {
    console.warn(`Unable to read network fee for ${signature}:`, error);
    return null;
  }
}
