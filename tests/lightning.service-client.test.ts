import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  DepositInputError,
  FixedFloatClient,
  FixedFloatError,
  type FixedFloatOrder,
} from "../src/services/lightning/fixedfloat";
import { DepositStore } from "../src/services/lightning/store";
import { LightningDeposits, hasSettlementTransfer } from "../src/services/lightning/service";
import { usdToSats } from "../src/services/lightning/usd";
import { depositMessage } from "../src/handlers/lightning";

const destination = "So11111111111111111111111111111111111111112";
// Mainnet BOLT11 prefix for 100u (10,000 sats); the rest is synthetic filler.
const invoice = "lnbc100u1syntheticinvoice";

const order = (overrides: Partial<FixedFloatOrder> = {}): FixedFloatOrder => ({
  id: "TEST01",
  token: "synthetic-token",
  type: "float",
  status: "NEW",
  time: { expiration: Math.floor(Date.now() / 1000) + 600 },
  from: { code: "BTCLN", amount: "0.00010000", address: invoice },
  to: { code: "SOL", amount: "0.02", address: destination },
  ...overrides,
});
const quote = {
  from: { code: "BTCLN", amount: "0.00010000", min: "0.00001", max: "1" },
  to: { code: "SOL", amount: "0.02" },
  errors: [],
};

const stores: DepositStore[] = [];
const store = () => {
  const created = new DepositStore("synthetic-key", ":memory:");
  stores.push(created);
  return created;
};
afterEach(() => {
  for (const item of stores.splice(0)) item.close();
});

const serviceWith = (
  db: DepositStore,
  client: Partial<ConstructorParameters<typeof LightningDeposits>[1]> = {},
) =>
  new LightningDeposits(
    db,
    {
      getQuote: async () => quote,
      create: async () => order(),
      order: async () => order(),
      ...client,
    },
    async () => false,
  );

describe("LightningDeposits.quote", () => {
  test("refuses a provider quote whose amount differs from the requested sats", async () => {
    const db = store();
    const service = serviceWith(db, {
      getQuote: async () => ({ ...quote, from: { ...quote.from, amount: "0.00020000" } }),
    });
    await expect(service.quote("1", destination, "10000")).rejects.toThrow(
      "Quote amount changed. Please try again.",
    );
    expect(db.active("1")).toBeNull();
  });
});

describe("LightningDeposits.create", () => {
  test("a stale quote is cancelled instead of being turned into an invoice", async () => {
    const db = store();
    let created = 0;
    const service = serviceWith(db, {
      create: async () => {
        created++;
        return order();
      },
    });
    const deposit = await service.quote("1", destination, "10000");
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      const result = await service.create(deposit.id, "1");
      expect(result.state).toBe("expired");
    } finally {
      clock.mockRestore();
    }
    expect(created).toBe(0);
    expect(db.get(deposit.id)?.state).toBe("expired");
  });

  test("an invoice for the wrong amount is kept for recovery but never activated", async () => {
    const db = store();
    const service = serviceWith(db, {
      create: async () =>
        order({ from: { code: "BTCLN", amount: "0.00010000", address: "lnbc200u1synthetic" } }),
    });
    const deposit = await service.quote("1", destination, "10000");
    const result = await service.create(deposit.id, "1");
    expect(result.state).toBe("unknown");
    expect(result.order?.token).toBe("synthetic-token");
  });

  test("an already expired invoice is never activated", async () => {
    const db = store();
    const service = serviceWith(db, {
      create: async () => order({ time: { expiration: Math.floor(Date.now() / 1000) - 5 } }),
    });
    const deposit = await service.quote("1", destination, "10000");
    expect((await service.create(deposit.id, "1")).state).toBe("unknown");
  });
});

describe("LightningDeposits.poll", () => {
  const activeDeposit = async (db: DepositStore, service: LightningDeposits, attempts = 0) => {
    const deposit = await service.quote("1", destination, "10000");
    await service.create(deposit.id, "1");
    db.update(deposit.id, "active", undefined, 0, attempts);
    return deposit.id;
  };

  test("provider EXPIRED and EMERGENCY statuses map to their states with a slow poll", async () => {
    for (const [status, state] of [
      ["EXPIRED", "expired"],
      ["EMERGENCY", "emergency"],
    ] as const) {
      const db = store();
      const service = serviceWith(db, { order: async () => order({ status }) });
      const id = await activeDeposit(db, service);
      const before = Date.now();
      await service.poll();
      const saved = db.get(id)!;
      expect(saved.state).toBe(state);
      expect(saved.nextPoll).toBeGreaterThanOrEqual(before + 300_000);
    }
  });

  test("a mismatching provider order is treated as a failed poll and backs off", async () => {
    const db = store();
    const service = serviceWith(db, {
      order: async () => order({ to: { code: "SOL", amount: "0.02", address: "someone-else" } }),
    });
    const id = await activeDeposit(db, service);
    const before = Date.now();
    await service.poll();
    const saved = db.get(id)!;
    expect(saved.state).toBe("active");
    expect(saved.attempts).toBe(1);
    expect(saved.nextPoll).toBeGreaterThanOrEqual(before + 30_000);
    expect(saved.nextPoll).toBeLessThan(before + 30_000 + 5_000);
  });

  test("repeated failures back off exponentially up to five minutes", async () => {
    const db = store();
    const service = serviceWith(db, {
      order: async () => {
        throw new FixedFloatError(false);
      },
    });
    const id = await activeDeposit(db, service, 10);
    const before = Date.now();
    await service.poll();
    const saved = db.get(id)!;
    expect(saved.attempts).toBe(11);
    expect(saved.nextPoll).toBeGreaterThanOrEqual(before + 300_000);
    expect(saved.nextPoll).toBeLessThan(before + 300_000 + 5_000);
  });
});

describe("hasSettlementTransfer", () => {
  const transfer = (lamports: unknown) => ({
    program: "system",
    programId: { toString: () => "11111111111111111111111111111111" },
    parsed: { type: "transfer", info: { destination, lamports } },
  });
  const tx = (...instructions: unknown[]) => ({
    meta: { err: null, innerInstructions: [] },
    transaction: { message: { instructions } },
  });

  test("sums string lamports and ignores malformed amounts", () => {
    expect(hasSettlementTransfer(tx(transfer("20000000")), destination, 20_000_000n)).toBe(true);
    expect(
      hasSettlementTransfer(
        tx(transfer("12000000"), transfer(8_000_000)),
        destination,
        20_000_000n,
      ),
    ).toBe(true);
    expect(hasSettlementTransfer(tx(transfer("1e7")), destination, 1n)).toBe(false);
    expect(hasSettlementTransfer(tx(transfer("-5")), destination, 1n)).toBe(false);
    expect(hasSettlementTransfer(tx(transfer("19999999")), destination, 20_000_000n)).toBe(false);
  });
});

describe("usdToSats", () => {
  test("rejects a USD amount whose sat conversion is not a safe integer", () => {
    const market = { btcUsd: 1e-6, minSats: 1, maxSats: 1e18 };
    expect(() => usdToSats("10000", market)).toThrow(
      new DepositInputError("The deposit limits have changed. Choose another amount."),
    );
    expect(usdToSats("0.01", market)).toBe(String(Math.ceil((0.01 * 1e8) / 1e-6)));
  });
});

describe("FixedFloatClient transport guards", () => {
  const okResponse = (body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  const config = { key: "synthetic-key", secret: "synthetic-secret", refcode: "synthetic-ref" };

  test("a response that is not valid JSON is an ambiguous failure", async () => {
    const client = new FixedFloatClient(config, (async () =>
      okResponse("<html>gateway</html>")) as unknown as typeof fetch);
    await expect(client.order("TEST01", "synthetic-token")).rejects.toMatchObject({
      retrySafe: false,
    });
  });

  test("a response with the wrong envelope is an ambiguous failure", async () => {
    const client = new FixedFloatClient(config, (async () =>
      okResponse({ data: [] })) as unknown as typeof fetch);
    await expect(client.order("TEST01", "synthetic-token")).rejects.toMatchObject({
      retrySafe: false,
    });
  });

  test("requests beyond the weighted budget are refused locally until the window passes", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const client = new FixedFloatClient(
      config,
      (async () => {
        calls++;
        return okResponse({ code: 0, data: {} });
      }) as unknown as typeof fetch,
      () => clock,
    );
    // create weighs 50, so four fit in the 200 weight budget.
    for (let i = 0; i < 4; i++)
      await expect(client.create("10000", destination)).rejects.toMatchObject({
        retrySafe: false,
      });
    expect(calls).toBe(4);

    await expect(client.create("10000", destination)).rejects.toMatchObject({ retrySafe: true });
    expect(calls).toBe(4);

    clock += 61_000;
    await expect(client.create("10000", destination)).rejects.toMatchObject({ retrySafe: false });
    expect(calls).toBe(5);
  });
});

describe("depositMessage completed", () => {
  const completedDeposit = (to: FixedFloatOrder["to"]) => ({
    id: "d1",
    owner: "1",
    destination,
    sats: "10000",
    quotedSol: "0.02",
    state: "completed",
    created: Date.now(),
    order: order({ status: "DONE", to }),
    nextPoll: 0,
    attempts: 0,
    notified: "",
    messageId: null,
  });

  test("shows the actual USD value scaled to the amount that arrived", () => {
    const { text } = depositMessage(
      completedDeposit({
        code: "SOL",
        amount: "0.02",
        address: destination,
        usd: "4.00",
        tx: { id: "sig1", amount: "0.01" },
      }),
    );
    expect(text).toContain("0.01 SOL (≈ $2.00) arrived in your wallet.");
  });

  test("omits the USD value when the provider gave no price", () => {
    const { text } = depositMessage(
      completedDeposit({ code: "SOL", amount: "0.02", address: destination }),
    );
    expect(text).toContain("0.02 SOL arrived in your wallet.");
    expect(text).not.toContain("≈");
  });
});
