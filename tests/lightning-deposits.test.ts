import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import {
  FixedFloatClient,
  FixedFloatError,
  satsToBtc,
  invoiceMatchesSats,
  fixedFloatConfig,
  type FixedFloatOrder,
} from "../src/services/lightning/fixedfloat";
import { DepositStore } from "../src/services/lightning/store";
import { LightningDeposits, hasSettlementTransfer } from "../src/services/lightning/service";
import { depositMessage, depositQuoteErrorMessage } from "../src/handlers/lightning";

const destination = "So11111111111111111111111111111111111111112";
const order = (): FixedFloatOrder => ({
  id: "TEST01",
  token: "synthetic-token",
  type: "float",
  status: "NEW",
  time: { expiration: Math.floor(Date.now() / 1000) + 600 },
  from: { code: "BTCLN", amount: "0.00010000", address: "lnbc100u1syntheticinvoice" },
  to: { code: "SOL", amount: "0.02", address: destination },
});
const quote = {
  from: { code: "BTCLN", amount: "0.00010000", min: "0.00001", max: "1" },
  to: { code: "SOL", amount: "0.02" },
  errors: [],
};
const store = () => new DepositStore("synthetic-key", ":memory:");

describe("Lightning deposits", () => {
  test("formats sats without floating point rounding", () => {
    expect(satsToBtc("1")).toBe("0.00000001");
    expect(satsToBtc("10000")).toBe("0.00010000");
    for (const invalid of ["0", "-1", "1.2", "1e8", " 1"])
      expect(() => satsToBtc(invalid)).toThrow();
  });
  test("signs exactly the JSON bytes sent and does not retry an ambiguous create", async () => {
    let calls = 0;
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      calls++;
      expect(new Headers(init.headers).get("X-API-SIGN")).toBe(
        createHmac("sha256", "synthetic-secret").update(String(init.body)).digest("hex"),
      );
      expect(JSON.parse(String(init.body))).toMatchObject({
        fromCcy: "BTCLN",
        toCcy: "SOL",
        amount: "0.00010000",
        toAddress: destination,
        type: "float",
        refcode: "synthetic-ref",
        afftax: 0.5,
      });
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const client = new FixedFloatClient(
      { key: "synthetic-key", secret: "synthetic-secret", refcode: "synthetic-ref" },
      fetcher,
    );
    await expect(client.create("10000", destination)).rejects.toMatchObject({ retrySafe: false });
    expect(calls).toBe(1);
  });
  test("duplicate creation and another user cannot create a second order", async () => {
    const db = store();
    let calls = 0;
    const service = new LightningDeposits(
      db,
      {
        getQuote: async () => quote,
        create: async () => {
          calls++;
          await Promise.resolve();
          return order();
        },
        order: async () => order(),
      },
      async () => true,
    );
    const deposit = await service.quote("1", destination, "10000");
    await expect(service.create(deposit.id, "2")).rejects.toThrow("not found");
    await Promise.all([service.create(deposit.id, "1"), service.create(deposit.id, "1")]);
    expect(calls).toBe(1);
    expect(db.get(deposit.id)?.state).toBe("active");
    expect(db.get(deposit.id)?.order?.token).toBe("synthetic-token");
    db.close();
  });
  test("ambiguous creation stays unknown and does not retry", async () => {
    const db = store();
    let calls = 0;
    const service = new LightningDeposits(
      db,
      {
        getQuote: async () => quote,
        create: async () => {
          calls++;
          throw new FixedFloatError(false);
        },
        order: async () => order(),
      },
      async () => true,
    );
    const deposit = await service.quote("1", destination, "10000");
    expect((await service.create(deposit.id, "1")).state).toBe("unknown");
    await service.create(deposit.id, "1");
    expect(calls).toBe(1);
    db.close();
  });
  test("settlement waits for the destination chain and completion is not repolled", async () => {
    const db = store();
    let confirmed = false;
    let polls = 0;
    const done = {
      ...order(),
      status: "DONE" as const,
      to: { ...order().to, tx: { id: "synthetic-signature", amount: "0.02" } },
    };
    const service = new LightningDeposits(
      db,
      {
        getQuote: async () => quote,
        create: async () => order(),
        order: async () => {
          polls++;
          return done;
        },
      },
      async (_sig, address, amount) => {
        expect(address).toBe(destination);
        expect(amount).toBe(20_000_000n);
        return confirmed;
      },
    );
    const deposit = await service.quote("1", destination, "10000");
    await service.create(deposit.id, "1");
    db.update(deposit.id, "active", undefined, 0);
    await service.poll();
    expect(db.get(deposit.id)?.state).toBe("settling");
    confirmed = true;
    db.update(deposit.id, "settling", undefined, 0);
    await service.poll();
    expect(db.get(deposit.id)?.state).toBe("completed");
    await service.poll();
    expect(polls).toBe(2);
    db.close();
  });
  test("rejects wrong destinations and never displays expired payment instructions", async () => {
    const db = store();
    const service = new LightningDeposits(
      db,
      {
        getQuote: async () => quote,
        create: async () => ({ ...order(), to: { ...order().to, address: "wrong" } }),
        order: async () => order(),
      },
      async () => true,
    );
    const deposit = await service.quote("1", destination, "10000");
    expect((await service.create(deposit.id, "1")).state).toBe("unknown");
    const expired = { ...order(), time: { expiration: 0 } };
    db.update(deposit.id, "active", expired);
    expect(depositMessage(db.get(deposit.id)!).text).not.toContain(expired.from.address);
    db.close();
  });
  test("requires an explicit successful SOL transfer to the recipient", () => {
    const tx = {
      meta: { err: null },
      transaction: {
        message: {
          instructions: [
            {
              program: "system",
              programId: "11111111111111111111111111111111",
              parsed: { type: "transfer", info: { destination, lamports: 20_000_000 } },
            },
          ],
        },
      },
    };
    expect(hasSettlementTransfer(tx, destination, 20_000_000n)).toBe(true);
    expect(hasSettlementTransfer(tx, "other", 20_000_000n)).toBe(false);
    expect(hasSettlementTransfer(tx, destination, 30_000_000n)).toBe(false);
    expect(hasSettlementTransfer({ ...tx, meta: { err: "failed" } }, destination, 1n)).toBe(false);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("restart restores orders, hides plaintext tokens, and preserves ambiguous requests", () => {
  const directory = mkdtempSync(join(tmpdir(), "timba-lightning-test-"));
  const path = join(directory, "journal.sqlite");
  try {
    let db = new DepositStore("synthetic-key", path);
    const pending = db.quote("1", destination, "10000", "0.02");
    db.update(pending.id, "active", order());
    const creating = db.quote("2", destination, "10000", "0.02");
    db.admit(creating.id, "2");
    const oldQuote = db.quote("3", destination, "10000", "0.02");
    db.close();
    expect(readFileSync(path).includes(Buffer.from("synthetic-token"))).toBe(false);
    db = new DepositStore("synthetic-key", path, true);
    expect(db.get(pending.id)?.order?.token).toBe("synthetic-token");
    expect(db.get(creating.id)?.state).toBe("unknown");
    expect(db.get(oldQuote.id)?.state).toBe("expired");
    expect(db.admit(oldQuote.id, "3")).toBe(false);
    expect(() => db.abandonUnknown(pending.id, "test evidence")).toThrow();
    db.abandonUnknown(creating.id, "synthetic provider evidence: no payable order");
    expect(db.get(creating.id)?.state).toBe("failed");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unresolved lists only ambiguous deposits for operator review", () => {
  const db = store();
  const active = db.quote("1", destination, "10000", "0.02");
  db.update(active.id, "active", order());
  const ambiguous = db.quote("2", destination, "20000", "0.04");
  db.update(ambiguous.id, "unknown", order());

  const unresolved = db.unresolved();
  expect(unresolved.map((deposit) => deposit.id)).toEqual([ambiguous.id]);
  expect(unresolved[0]?.owner).toBe("2");
  expect(unresolved[0]?.order?.token).toBe("synthetic-token");

  db.abandonUnknown(ambiguous.id, "synthetic provider evidence: no payable order");
  expect(db.unresolved()).toEqual([]);
  db.close();
});

test("continues reconciling late payments on expired invoices", async () => {
  const db = store();
  const expired = { ...order(), status: "EXPIRED" as const };
  const deposit = db.quote("1", destination, "10000", "0.02");
  db.update(deposit.id, "expired", expired, 0);
  // A new quote must not prevent tracking an earlier late payment.
  db.quote("1", destination, "10000", "0.02");
  const service = new LightningDeposits(
    db,
    {
      getQuote: async () => quote,
      create: async () => order(),
      order: async () => ({ ...order(), status: "EMERGENCY" }),
    },
    async () => false,
  );
  await service.poll();
  expect(db.get(deposit.id)?.state).toBe("emergency");
  db.close();
});

test("invoice network and amount must match the requested sats", () => {
  expect(invoiceMatchesSats("lnbc100u1synthetic", "10000")).toBe(true);
  expect(invoiceMatchesSats("lnbc200u1synthetic", "10000")).toBe(false);
  expect(invoiceMatchesSats("lntb100u1synthetic", "10000")).toBe(false);
  expect(invoiceMatchesSats("lnbc10000p1synthetic", "1")).toBe(true);
});

test("requires referral configuration only when enabled", () => {
  expect(fixedFloatConfig({})).toBeNull();
  const env = {
    FIXEDFLOAT_ENABLED: "true",
    FIXEDFLOAT_API_KEY: "synthetic-key",
    FIXEDFLOAT_API_SECRET: "synthetic-secret",
  };
  expect(() => fixedFloatConfig(env)).toThrow("FIXEDFLOAT_REFCODE");
  expect(() => fixedFloatConfig({ ...env, FIXEDFLOAT_REFCODE: " " })).toThrow();
  expect(fixedFloatConfig({ ...env, FIXEDFLOAT_REFCODE: " synthetic-ref " })?.refcode).toBe(
    "synthetic-ref",
  );
});

test("quote and invoice creation use identical floating affiliate terms", async () => {
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const client = new FixedFloatClient(
    { key: "synthetic-key", secret: "synthetic-secret", refcode: "synthetic-ref" },
    (async (url: unknown, init: RequestInit) => {
      const method = String(url).split("/").at(-1)!;
      requests.push({ method, body: JSON.parse(String(init.body)) });
      const data =
        method === "ccies"
          ? [
              { code: "BTCLN", coin: "BTC", network: "LN", recv: 1, send: 0 },
              { code: "SOL", coin: "SOL", network: "SOL", recv: 0, send: 1 },
            ]
          : method === "price"
            ? quote
            : order();
      return Response.json({ code: 0, data });
    }) as typeof fetch,
  );
  await client.getQuote("10000");
  await client.create("10000", destination);
  expect(requests.map((r) => r.method)).toEqual(["ccies", "price", "create"]);
  expect(requests[1]!.body).toEqual({
    fromCcy: "BTCLN",
    toCcy: "SOL",
    amount: "0.00010000",
    direction: "from",
    type: "float",
    refcode: "synthetic-ref",
    afftax: 0.5,
  });
  expect(requests[2]!.body).toEqual({ ...requests[1]!.body, toAddress: destination });
});

test("shows provider rules and floating estimates before payment", () => {
  const db = store();
  try {
    const deposit = db.quote("1", destination, "10000", "0.02");
    for (const state of ["quoted", "active"]) {
      if (state === "active") db.update(deposit.id, state, order());
      const message = depositMessage(db.get(deposit.id)!);
      expect(message.text).toContain("You receive: ≈");
      expect(message.text).toContain("Fee: 1%");
      expect(message.text).toContain("https://ff.io/terms-of-service");
      expect(message.text).toContain("Exchange provided by");
    }
  } finally {
    db.close();
  }
});

test("rejects fixed-rate responses for new orders without revealing their invoice", async () => {
  const db = store();
  try {
    const service = new LightningDeposits(
      db,
      {
        getQuote: async () => quote,
        create: async () => ({ ...order(), type: "fixed" }),
        order: async () => order(),
      },
      async () => true,
    );
    const deposit = await service.quote("1", destination, "10000");
    const result = await service.create(deposit.id, "1");
    expect(result.state).toBe("unknown");
    expect(result.order?.token).toBe("synthetic-token");
    expect(depositMessage(result).text).not.toContain("lnbc");
  } finally {
    db.close();
  }
});

test("preserves legacy fixed orders and accepts changed floating output at settlement", async () => {
  for (const type of ["fixed", "float"] as const) {
    const db = store();
    try {
      const deposit = db.quote("1", destination, "10000", "0.02");
      db.update(deposit.id, "active", { ...order(), type }, 0);
      const done = {
        ...order(),
        type,
        status: "DONE" as const,
        to: { ...order().to, amount: "0.019", tx: { id: "synthetic-signature", amount: "0.019" } },
      };
      let observed = 0n;
      const service = new LightningDeposits(
        db,
        {
          getQuote: async () => quote,
          create: async () => order(),
          order: async () => done,
        },
        async (_signature, recipient, amount) => {
          expect(recipient).toBe(destination);
          observed = amount;
          return true;
        },
      );
      await service.poll();
      expect(observed).toBe(19_000_000n);
      expect(db.get(deposit.id)?.state).toBe("completed");
    } finally {
      db.close();
    }
  }
});

test("availability accepts boolean flags and rejects disabled or malformed routes", async () => {
  for (const recv of [true, false, 0, 2, "1"]) {
    let priceCalls = 0;
    const client = new FixedFloatClient(
      { key: "synthetic-key", secret: "synthetic-secret", refcode: "synthetic-ref" },
      (async (url: unknown) => {
        if (String(url).endsWith("/ccies"))
          return Response.json({
            code: 0,
            data: [
              { code: "BTCLN", coin: "BTC", network: "LN", recv, send: false },
              { code: "SOL", coin: "SOL", network: "SOL", recv: false, send: true },
            ],
          });
        priceCalls++;
        return Response.json({ code: 0, data: quote });
      }) as typeof fetch,
    );
    if (recv === true) {
      expect((await client.getQuote("10000")).to.amount).toBe("0.02");
      expect(priceCalls).toBe(1);
    } else {
      await expect(client.getQuote("10000")).rejects.toThrow();
      expect(priceCalls).toBe(0);
    }
  }
});

test("quote limits are shown in sats and unexpected errors stay private", async () => {
  const client = new FixedFloatClient(
    { key: "synthetic-key", secret: "synthetic-secret", refcode: "synthetic-ref" },
    (async (url: unknown, init: RequestInit) => {
      if (String(url).endsWith("/ccies"))
        return Response.json({
          code: 0,
          data: [
            { code: "BTCLN", coin: "BTC", network: "LN", recv: 1, send: 0 },
            { code: "SOL", coin: "SOL", network: "SOL", recv: 0, send: 1 },
          ],
        });
      const amount = JSON.parse(String(init.body)).amount;
      return Response.json({
        code: 0,
        data: {
          ...quote,
          from: { ...quote.from, amount, min: "0.00015000", max: "0.2" },
          errors: ["amount"],
        },
      });
    }) as typeof fetch,
  );
  for (const [sats, expected] of [
    ["10000", "Minimum deposit: 15,000 sats."],
    ["20000001", "Maximum deposit: 20,000,000 sats."],
  ]) {
    let error: unknown;
    try {
      await client.getQuote(sats!);
    } catch (caught) {
      error = caught;
    }
    expect(depositQuoteErrorMessage(error)).toBe(expected!);
  }
  expect(depositQuoteErrorMessage(new Error("synthetic private provider data"))).toBe(
    "Unable to get a quote right now. Please try again shortly.",
  );
});

describe("FixedFloatClient requests", () => {
  const okJson = (data: unknown) => Response.json({ code: 0, data });

  test("defaults to the global fetch and reads order status with the order token", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return okJson(order());
    }) as unknown as typeof fetch;
    let client: FixedFloatClient;
    try {
      client = new FixedFloatClient({ key: "k", secret: "s", refcode: "r" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const status = await client.order("TEST01", "synthetic-token");
    expect(status.id).toBe("TEST01");
    expect(status.status).toBe("NEW");
    expect(requests).toEqual([
      { url: "https://ff.io/api/v2/order", body: { id: "TEST01", token: "synthetic-token" } },
    ]);
  });

  test("a malformed create response is ambiguous and never marked retry-safe", async () => {
    const client = new FixedFloatClient(
      { key: "k", secret: "s", refcode: "r" },
      (async () => okJson({ ...order(), token: "" })) as unknown as typeof fetch,
      () => 1_000,
    );

    const failure = await client.create("10000", destination).catch((error) => error);
    expect(failure).toBeInstanceOf(FixedFloatError);
    expect(failure.retrySafe).toBe(false);
  });

  test("rejects order lookups whose payload does not match the order schema", async () => {
    const client = new FixedFloatClient({ key: "k", secret: "s", refcode: "r" }, (async () =>
      okJson({ ...order(), id: "bad id" })) as unknown as typeof fetch);

    await expect(client.order("TEST01", "synthetic-token")).rejects.toThrow();
  });
});
