import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getConfirmedTransactionFeeLamports } from "../src/utils/transaction-fee";

let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

const connectionReturning = (value: unknown) => ({
  getTransaction: mock(async () => value),
});

describe("getConfirmedTransactionFeeLamports", () => {
  test("returns the confirmed fee and asks for versioned transactions", async () => {
    const connection = connectionReturning({ meta: { fee: 5000 } });

    expect(await getConfirmedTransactionFeeLamports(connection as any, "sig")).toBe(5000);
    expect(connection.getTransaction).toHaveBeenCalledWith("sig", {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  });

  test("accepts a zero fee", async () => {
    expect(
      await getConfirmedTransactionFeeLamports(
        connectionReturning({ meta: { fee: 0 } }) as any,
        "s",
      ),
    ).toBe(0);
  });

  test("returns null without calling RPC when there is no signature", async () => {
    const connection = connectionReturning({ meta: { fee: 1 } });

    expect(await getConfirmedTransactionFeeLamports(connection as any, undefined)).toBeNull();
    expect(await getConfirmedTransactionFeeLamports(connection as any, "")).toBeNull();
    expect(connection.getTransaction).not.toHaveBeenCalled();
  });

  test("returns null when the connection cannot fetch transactions", async () => {
    expect(await getConfirmedTransactionFeeLamports({} as any, "sig")).toBeNull();
  });

  test.each([
    ["missing transaction", null],
    ["missing meta", {}],
    ["non-numeric fee", { meta: { fee: "5000" } }],
    ["negative fee", { meta: { fee: -1 } }],
    ["fractional fee", { meta: { fee: 1.5 } }],
    ["unsafe integer fee", { meta: { fee: Number.MAX_SAFE_INTEGER + 1 } }],
  ])("returns null for a %s", async (_label, value) => {
    expect(
      await getConfirmedTransactionFeeLamports(connectionReturning(value) as any, "sig"),
    ).toBeNull();
  });

  test("returns null and warns when the RPC call fails", async () => {
    const error = new Error("rpc down");
    const connection = {
      getTransaction: async () => {
        throw error;
      },
    };

    expect(await getConfirmedTransactionFeeLamports(connection as any, "sig")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("Unable to read network fee for sig:", error);
  });
});
