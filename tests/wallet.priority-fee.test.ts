import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "#solana";
import { WalletManager } from "../src/utils/wallet";
import {
  PRIORITY_FEE_MAX_LAMPORTS,
  PRIORITY_FEE_MIN_MICRO_LAMPORTS,
  REBROADCAST_INTERVAL_MS,
  SIGNATURE_POLL_INTERVAL_MS,
} from "../src/utils/constants";
import { stubInstantTimers } from "./helpers/timers";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ACTIVE = "https://rpc-a.example";
const OTHER = "https://rpc-b.example";
const BLOCKHASH = PublicKey.default.toBase58();

let instantTimers: ReturnType<typeof stubInstantTimers>;
const originalFetch = globalThis.fetch;
let rpcCalls: { url: string; method: string; params: any }[];
let rpcResults: Record<string, (params: any) => unknown>;

beforeEach(() => {
  instantTimers = stubInstantTimers();
  rpcCalls = [];
  rpcResults = {};
  globalThis.fetch = (async (input: any, init: any) => {
    const body = JSON.parse(init.body);
    rpcCalls.push({ url: String(input), method: body.method, params: body.params });
    const result = rpcResults[body.method];
    if (!result) return new Response(JSON.stringify({ error: { message: "unsupported" } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: result(body.params) }));
  }) as any;
});
afterEach(() => {
  instantTimers.restore();
  globalThis.fetch = originalFetch;
});

type Simulation = { err: unknown; unitsConsumed?: unknown } | Error;

const connection = (simulation: Simulation = { err: null, unitsConsumed: 50_000 }) => {
  const sent: any[] = [];
  const simulations: any[] = [];
  const conn: any = {
    rpcEndpoint: ACTIVE,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    simulateTransaction: async (tx: any, config: any) => {
      simulations.push({ tx, config });
      if (simulation instanceof Error) throw simulation;
      return { value: simulation };
    },
    sendTransaction: async (tx: any) => {
      sent.push(tx);
      return "SENT_SIG";
    },
  };
  return { conn, sent, simulations };
};

const walletFor = (conn: any) =>
  WalletManager.createForTest(MNEMONIC, {
    connection: conn,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });

const READ_ONLY = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const transfer = (payer: PublicKey) => {
  const ix = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: PublicKey.default,
    lamports: 1,
  });
  ix.keys.push({ pubkey: READ_ONLY, isSigner: false, isWritable: false });
  return ix;
};

/** Compute budget instructions of a sent transaction: `[unit limit, micro-lamports per unit]`. */
const computeBudgetOf = (tx: any): [number, number] | null => {
  const keys = tx.message.staticAccountKeys.map((key: PublicKey) => key.toBase58());
  const budget = tx.message.compiledInstructions.filter(
    (ix: any) => keys[ix.programIdIndex] === ComputeBudgetProgram.programId.toBase58(),
  );
  if (budget.length === 0) return null;
  const [limit, price] = budget.map((ix: any) => Buffer.from(ix.data));
  expect(limit[0]).toBe(2);
  expect(price[0]).toBe(3);
  return [limit.readUInt32LE(1), Number(price.readBigUInt64LE(1))];
};

const sendGameTransaction = async (
  simulation?: Simulation,
  estimate?: (params: any) => unknown,
  options: { priorityFee?: boolean } = { priorityFee: true },
) => {
  const { conn, sent, simulations } = connection(simulation);
  if (estimate) rpcResults["getPriorityFeeEstimate"] = estimate;
  const payer = await Keypair.generate();
  await walletFor(conn).sendTransaction([transfer(payer.publicKey)], [payer], options);
  return { tx: sent[0], simulations, payer };
};

describe("priority fees on game transactions", () => {
  test("bid the estimated fee within a compute limit simulated with headroom", async () => {
    const { tx, simulations, payer } = await sendGameTransaction(undefined, () => ({
      priorityFeeEstimate: 40_093.2,
    }));

    // 50,000 simulated units, 20% headroom, plus the budget instructions themselves.
    expect(computeBudgetOf(tx)).toEqual([61_000, 40_094]);
    expect(simulations[0].config).toEqual({
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    const estimate = rpcCalls.find((call) => call.method === "getPriorityFeeEstimate")!;
    expect(estimate.url).toBe(ACTIVE);
    expect(estimate.params[0].options).toEqual({ priorityLevel: "High" });
    expect(estimate.params[0].accountKeys).toContain(payer.publicKey.toBase58());
    // Only accounts the transaction writes compete for priority.
    expect(estimate.params[0].accountKeys).not.toContain(READ_ONLY.toBase58());
  });

  test("keep the fee between the floor and the per-transaction cap", async () => {
    const floor = await sendGameTransaction(undefined, () => ({ priorityFeeEstimate: 3 }));
    expect(computeBudgetOf(floor.tx)).toEqual([61_000, PRIORITY_FEE_MIN_MICRO_LAMPORTS]);

    const huge = await sendGameTransaction(undefined, () => ({ priorityFeeEstimate: 1e12 }));
    const [limit, price] = computeBudgetOf(huge.tx)!;
    expect(price).toBe(Math.floor((PRIORITY_FEE_MAX_LAMPORTS * 1_000_000) / limit));
    expect((limit * price) / 1_000_000).toBeLessThanOrEqual(PRIORITY_FEE_MAX_LAMPORTS);

    const busy = await sendGameTransaction({ err: null, unitsConsumed: 2_000 }, () => ({
      priorityFeeEstimate: 900_000,
    }));
    expect(computeBudgetOf(busy.tx)).toEqual([3_400, 500_000]);

    const large = await sendGameTransaction({ err: null, unitsConsumed: 2_000_000 }, () => ({
      priorityFeeEstimate: 0,
    }));
    expect(computeBudgetOf(large.tx)![0]).toBe(1_400_000);
  });

  test("fall back to the floor when the RPC has no estimate", async () => {
    for (const estimate of [
      undefined,
      () => ({}),
      () => ({ priorityFeeEstimate: -1 }),
      () => ({ priorityFeeEstimate: "soon" }),
    ]) {
      const { tx } = await sendGameTransaction(undefined, estimate);
      expect(computeBudgetOf(tx)).toEqual([61_000, PRIORITY_FEE_MIN_MICRO_LAMPORTS]);
    }
  });

  test("send the transaction unchanged when the simulation gives no units", async () => {
    for (const simulation of [
      { err: { InstructionError: [0, "Custom"] }, unitsConsumed: 10 },
      { err: null, unitsConsumed: 0 },
      { err: null },
      new Error("simulation unavailable"),
    ]) {
      const { tx } = await sendGameTransaction(simulation, () => ({ priorityFeeEstimate: 1 }));
      expect(computeBudgetOf(tx)).toBeNull();
      expect(tx.message.compiledInstructions).toHaveLength(1);
    }
  });

  test("leave other transactions and self-budgeted ones alone", async () => {
    const plain = await sendGameTransaction(undefined, undefined, {});
    expect(computeBudgetOf(plain.tx)).toBeNull();
    expect(plain.simulations).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);

    const { conn, sent, simulations } = connection();
    const payer = await Keypair.generate();
    const own = ComputeBudgetProgram.setComputeUnitLimit({ units: 7_000 });
    await walletFor(conn).sendTransaction([own, transfer(payer.publicKey)], [payer], {
      priorityFee: true,
    });
    expect(simulations).toHaveLength(0);
    expect(sent[0].message.compiledInstructions).toHaveLength(2);
  });

  test("resubmits keep bidding a priority fee", async () => {
    const { conn, sent } = connection();
    let polls = 0;
    conn.getSignatureStatuses = async () => {
      polls += 1;
      return { value: [polls === 1 ? { err: null, confirmationStatus: "processed" } : null] };
    };
    const wallet = walletFor(conn);
    let confirms = 0;
    (wallet as any).confirmTransaction = async () => {
      confirms += 1;
      if (confirms === 1) throw new Error("Transaction expired before confirmation");
    };
    const payer = await Keypair.generate();

    await wallet.sendAndConfirmWithResubmits([transfer(payer.publicKey)], [payer], {
      priorityFee: true,
    });

    expect(sent).toHaveLength(2);
    expect(sent.map((tx) => computeBudgetOf(tx))).toEqual([
      [61_000, PRIORITY_FEE_MIN_MICRO_LAMPORTS],
      [61_000, PRIORITY_FEE_MIN_MICRO_LAMPORTS],
    ]);
  });
});

describe("rebroadcasting pending transactions", () => {
  const pendingWallet = (statuses: (string | null)[]) => {
    const { conn, sent } = connection();
    const raw: { bytes: Buffer; options: any }[] = [];
    conn.getBlockHeight = async () => 1;
    conn.sendRawTransaction = async (bytes: Uint8Array, options: any) => {
      raw.push({ bytes: Buffer.from(bytes), options });
      return "SENT_SIG";
    };
    let poll = 0;
    conn.getSignatureStatuses = async () => {
      const status = statuses[Math.min(poll++, statuses.length - 1)];
      return { value: [status ? { err: null, confirmationStatus: status } : null] };
    };
    const wallet = walletFor(conn);
    (wallet as any).rebroadcastIntervalMs = 0;
    return { wallet, conn, sent, raw };
  };

  test("defaults poll every 400ms and resend every 2s", () => {
    const wallet = walletFor(connection().conn) as any;
    expect(wallet.signaturePollIntervalMs).toBe(SIGNATURE_POLL_INTERVAL_MS);
    expect(SIGNATURE_POLL_INTERVAL_MS).toBe(400);
    expect(wallet.rebroadcastIntervalMs).toBe(REBROADCAST_INTERVAL_MS);
    expect(REBROADCAST_INTERVAL_MS).toBe(2_000);
  });

  test("resend the signed bytes to every endpoint until the transaction lands", async () => {
    const { wallet, sent, raw } = pendingWallet([null, "processed", null, "confirmed"]);
    (wallet as any).rpcEndpointManager = { getAllEndpoints: () => [ACTIVE, OTHER] };
    rpcResults["sendTransaction"] = () => "SENT_SIG";
    const payer = await Keypair.generate();

    const signature = await wallet.sendTransaction([transfer(payer.publicKey)], [payer]);
    await wallet.confirmTransaction(signature);

    const signed = Buffer.from(sent[0].serialize());
    expect(raw).toHaveLength(3);
    for (const resend of raw) {
      expect(resend.bytes.equals(signed)).toBe(true);
      expect(resend.options).toEqual({ skipPreflight: true, maxRetries: 0n });
    }
    const others = rpcCalls.filter((call) => call.method === "sendTransaction");
    expect(others.map((call) => call.url)).toEqual([OTHER, OTHER, OTHER]);
    expect(others[0]?.params).toEqual([
      signed.toString("base64"),
      { encoding: "base64", skipPreflight: true, maxRetries: 0 },
    ]);
  });

  test("wait the interval between resends", async () => {
    const { wallet, raw } = pendingWallet([null, null, null, "confirmed"]);
    (wallet as any).rebroadcastIntervalMs = 60_000;
    const payer = await Keypair.generate();

    await wallet.confirmTransaction(
      await wallet.sendTransaction([transfer(payer.publicKey)], [payer]),
    );

    expect(raw).toHaveLength(0);
  });

  test("untracked signatures are only polled", async () => {
    const { wallet, raw } = pendingWallet([null, "confirmed"]);

    await wallet.confirmTransaction("UNTRACKED_SIG");

    expect(raw).toHaveLength(0);
  });

  test("failed resends are logged without endpoint URLs and do not stop confirmation", async () => {
    const { wallet, conn } = pendingWallet([null, null, "confirmed"]);
    (wallet as any).rpcEndpointManager = { getAllEndpoints: () => [ACTIVE, OTHER] };
    conn.sendRawTransaction = async () => {
      throw new Error(`send failed at ${ACTIVE}`);
    };
    // The other endpoint accepts the first resend and refuses the second.
    let otherSends = 0;
    rpcResults["sendTransaction"] = () => {
      otherSends += 1;
      if (otherSends > 1) throw new Error("refused");
      return "SENT_SIG";
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    const payer = await Keypair.generate();
    try {
      await wallet.confirmTransaction(
        await wallet.sendTransaction([transfer(payer.publicKey)], [payer]),
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.filter((warning) => warning.includes("Rebroadcast"))).toEqual([
      "⚠️ Rebroadcast failed on 1/2 RPC endpoints",
      "⚠️ Rebroadcast failed on 2/2 RPC endpoints",
    ]);
    expect(warnings.join("\n")).not.toContain("rpc-");
  });
});
