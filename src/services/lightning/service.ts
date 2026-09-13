import { parseTokenAmount } from "@timbagame/protocol/amounts";
import {
  FixedFloatClient,
  FixedFloatError,
  satsToBtc,
  invoiceMatchesSats,
  type FixedFloatOrder,
} from "./fixedfloat";
import { DepositStore, type Deposit } from "./store";

export class LightningDeposits {
  private polling = false;
  constructor(
    readonly store: DepositStore,
    private readonly client: Pick<FixedFloatClient, "getQuote" | "create" | "order">,
    private readonly confirm: (
      signature: string,
      destination: string,
      lamports: bigint,
    ) => Promise<boolean>,
  ) {}
  async quote(owner: string, destination: string, sats: string) {
    const active = this.store.active(owner);
    if (active) return active;
    satsToBtc(sats);
    const quote = await this.client.getQuote(sats);
    if (parseTokenAmount(quote.from.amount, 8) !== BigInt(sats))
      throw new Error("Quote amount changed. Please try again.");
    // A competing request may have won while fetching the quote.
    return (
      this.store.active(owner) ??
      this.store.quote(owner, destination, sats, quote.to.amount, quote.from.usd, quote.to.usd)
    );
  }
  private validate(order: FixedFloatOrder, deposit: Deposit) {
    if (
      order.from.code !== "BTCLN" ||
      order.to.code !== "SOL" ||
      order.to.address !== deposit.destination ||
      order.type !== (deposit.order?.type ?? "float") ||
      parseTokenAmount(order.from.amount, 8) !== BigInt(deposit.sats) ||
      (deposit.order && order.id !== deposit.order.id)
    )
      throw new Error("Order details do not match the deposit");
  }
  async create(id: string, owner: string) {
    const deposit = this.store.get(id);
    if (!deposit || deposit.owner !== owner) throw new Error("Deposit not found.");
    if (!this.store.admit(id, owner)) {
      if (deposit.state === "quoted" && deposit.created < Date.now() - 60_000)
        this.store.cancelQuote(id, owner);
      return this.store.get(id)!;
    }
    try {
      const order = await this.client.create(deposit.sats, deposit.destination);
      // Save recovery credentials before validating or sending any payment instructions.
      this.store.update(id, "unknown", order);
      this.validate(order, deposit);
      if (
        !invoiceMatchesSats(order.from.address, deposit.sats) ||
        order.time.expiration * 1000 <= Date.now()
      )
        throw new Error("Invoice unavailable");
      this.store.update(id, "active", order);
    } catch (error) {
      this.store.update(
        id,
        error instanceof FixedFloatError && error.retrySafe ? "failed" : "unknown",
      );
    }
    return this.store.get(id)!;
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const deposit of this.store.due()) {
        try {
          if (!deposit.order?.token) continue;
          const order = await this.client.order(deposit.order.id, deposit.order.token);
          this.validate(order, deposit);
          order.token = deposit.order.token;
          let state =
            order.status === "EXPIRED"
              ? "expired"
              : order.status === "EMERGENCY"
                ? "emergency"
                : "active";
          if (order.status === "DONE") {
            state = "settling";
            if (
              order.to.tx?.id &&
              order.to.tx.amount &&
              (await this.confirm(
                order.to.tx.id,
                deposit.destination,
                parseTokenAmount(order.to.tx.amount, 9),
              ))
            )
              state = "completed";
          }
          this.store.update(
            deposit.id,
            state,
            order,
            Date.now() + (["emergency", "expired"].includes(state) ? 300_000 : 30_000),
          );
        } catch {
          this.store.update(
            deposit.id,
            deposit.state,
            undefined,
            Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(deposit.attempts, 4)),
            deposit.attempts + 1,
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

/** Accept only a successful finalized transaction with explicit native SOL transfers. */
export function hasSettlementTransfer(tx: unknown, destination: string, expected: bigint): boolean {
  if (!tx || expected <= 0n) return false;
  const data = tx as {
    meta?: { err: unknown; innerInstructions?: { instructions: unknown[] }[] };
    transaction?: { message?: { instructions?: unknown[] } };
  };
  if (!data.meta || data.meta.err !== null) return false;
  const instructions = [
    ...(data.transaction?.message?.instructions ?? []),
    ...(data.meta.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  let received = 0n;
  for (const raw of instructions) {
    const ix = raw as {
      program?: string;
      programId?: { toString(): string };
      parsed?: { type?: string; info?: { destination?: string; lamports?: number | string } };
    };
    if (
      ix.program !== "system" ||
      ix.programId?.toString() !== "11111111111111111111111111111111" ||
      !["transfer", "transferWithSeed"].includes(ix.parsed?.type ?? "") ||
      ix.parsed?.info?.destination !== destination
    )
      continue;
    const lamports = ix.parsed.info.lamports;
    if (typeof lamports === "number" && Number.isSafeInteger(lamports) && lamports > 0)
      received += BigInt(lamports);
    else if (typeof lamports === "string" && /^\d+$/.test(lamports)) received += BigInt(lamports);
  }
  return received >= expected;
}
