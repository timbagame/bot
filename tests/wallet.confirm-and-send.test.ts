import { describe, test, expect } from "bun:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WalletManager } from "../src/utils/wallet";
import { LAMPORTS_PER_SOL } from "../src/utils/constants";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class ConnConfirmOk implements Partial<Connection> {
  calls = 0;
  async getSignatureStatuses(_sig: string[]) {
    this.calls += 1;
    return { value: [{ confirmationStatus: "confirmed" }] } as any;
  }
}

class ConnConfirmErr implements Partial<Connection> {
  async getSignatureStatuses(_sig: string[]) {
    return {
      value: [{ err: { Custom: 1 }, confirmationStatus: "processed" }],
    } as any;
  }
}

class ConnSendMock implements Partial<Connection> {
  async getLatestBlockhash() {
    return { blockhash: "BH", lastValidBlockHeight: 1 } as any;
  }
  async sendTransaction() {
    return "SIG123456";
  }
}

describe("WalletManager confirmTransaction and sendTransaction", () => {
  test("confirmTransaction resolves when status is confirmed", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnConfirmOk() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    await wm.confirmTransaction("FAKESIG");
  });

  test("confirmTransaction throws when status has err", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnConfirmErr() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    await expect(wm.confirmTransaction("FAKESIG")).rejects.toThrow(/Transaction failed/);
  });

  test("sendTransaction throws without signers", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnSendMock() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    await expect(wm.sendTransaction([], [] as any)).rejects.toThrow(/No signers provided/);
  });

  test("transferSol delegates to sendTransaction and returns signature", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnSendMock() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    (wm as any).sendAndConfirmWithResubmits = async () => "ABCDEF12";
    const sig = await wm.transferSol(1n, Keypair.generate().publicKey, LAMPORTS_PER_SOL / 2);
    expect(sig).toBe("ABCDEF12");
  });

  test("confirmTransaction retries on 429 then succeeds", async () => {
    let calls = 0;
    const conn: any = {
      getSignatureStatuses: async () => {
        calls += 1;
        if (calls === 1) throw new Error("429 Too Many Requests");
        return { value: [{ confirmationStatus: "confirmed" }] };
      },
      getBlockHeight: async () => 1,
    };
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    await wm.confirmTransaction("FAKESIG");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("confirmTransaction throws when blockhash expires", async () => {
    const conn: any = {
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 105,
    };
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    (wm as any).pendingSignatures.set("EXPIREME", {
      blockhash: "BH",
      lastValidBlockHeight: 100,
      recordedAt: Date.now() - 10_000,
    });

    await expect(wm.confirmTransaction("EXPIREME")).rejects.toThrow(/expired before confirmation/);
  });

  test("probeTransactionAfterTimeout accepts versioned transactions", async () => {
    const probeOptions: any[] = [];
    const conn: any = {
      getTransaction: async (_sig: string, options: any) => {
        probeOptions.push(options);
        if (options?.maxSupportedTransactionVersion === 0) {
          throw new Error("Restricted to legacy transactions");
        }
        return { meta: { err: null } };
      },
      getSignatureStatus: async () => ({ value: [null] }),
    };

    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    (wm as any).postTimeoutProbeRetryDelayMs = 0;
    const result = await (wm as any).probeTransactionAfterTimeout("SIGV1");

    expect(result).toBe("found");
    expect(probeOptions[0]?.maxSupportedTransactionVersion).toBeUndefined();
  });

  test("probeTransactionAfterTimeout retries when getTransaction is rate limited", async () => {
    let attempts = 0;
    const conn: any = {
      getTransaction: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("429 Too Many Requests");
        }
        return { meta: { err: null } };
      },
      getSignatureStatus: async () => ({ value: [null] }),
    };

    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    (wm as any).postTimeoutProbeRetryDelayMs = 0;
    (wm as any).postTimeoutProbeMaxAttempts = 3;

    const result = await (wm as any).probeTransactionAfterTimeout("SIG429");

    expect(result).toBe("found");
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test("confirmTransaction resolves after timeout when post-timeout probe finds confirmation", async () => {
    let statusCalls = 0;
    let probeCalls = 0;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
    };

    const conn: any = {
      getSignatureStatuses: async () => {
        statusCalls += 1;
        return { value: [null] };
      },
      getBlockHeight: async () => 50,
      getTransaction: async () => {
        probeCalls += 1;
        return { meta: { err: null } };
      },
      getSignatureStatus: async () => ({ value: null }),
    };

    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    (wm as any).confirmationTimeoutMs = 20;
    (wm as any).signaturePollIntervalMs = 5;
    (wm as any).postTimeoutProbeBackoffMs = 0;
    (wm as any).postTimeoutProbeRetryDelayMs = 0;
    (wm as any).postTimeoutProbeMaxAttempts = 1;

    (wm as any).pendingSignatures.set("TIMEOUT_SIG", {
      blockhash: "BH",
      lastValidBlockHeight: 100,
      recordedAt: Date.now() - 5,
    });

    try {
      await wm.confirmTransaction("TIMEOUT_SIG");
    } finally {
      console.log = originalLog;
    }

    expect(statusCalls).toBeGreaterThan(0);
    expect(probeCalls).toBe(1);
    expect((wm as any).pendingSignatures.has("TIMEOUT_SIG")).toBe(false);
    expect(logs.some((entry) => entry.includes("Post-timeout probe recovered"))).toBe(true);
  });

  test("confirmTransaction throws timeout error when probes cannot find signature", async () => {
    const conn: any = {
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 50,
      getTransaction: async () => null,
      getSignatureStatus: async () => ({ value: null }),
    };

    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    (wm as any).confirmationTimeoutMs = 20;
    (wm as any).signaturePollIntervalMs = 5;
    (wm as any).postTimeoutProbeBackoffMs = 0;
    (wm as any).postTimeoutProbeRetryDelayMs = 0;
    (wm as any).postTimeoutProbeMaxAttempts = 1;

    (wm as any).pendingSignatures.set("MISSING_SIG", {
      blockhash: "BH",
      lastValidBlockHeight: 100,
      recordedAt: Date.now() - 5,
    });

    const errors: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((item) => String(item)).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      errors.push(args.map((item) => String(item)).join(" "));
    };

    try {
      await expect(wm.confirmTransaction("MISSING_SIG")).rejects.toThrow(
        /Transaction confirmation timeout/,
      );
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    expect(errors.some((entry) => entry.includes("postTimeoutProbe=missing"))).toBe(true);
  });

  test("getTokenBalance returns 0 on generic error", async () => {
    const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const conn: any = {
      getAccountInfo: async (pk: PublicKey) => {
        if (pk.equals(mint)) {
          return {
            owner: TOKEN_PROGRAM_ID,
            data: Buffer.alloc(0),
            executable: false,
            lamports: 0,
          } as any;
        }
        throw new Error("unexpected");
      },
    };
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: conn,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const val = await wm.getTokenBalance(1n, mint.toBase58());
    expect(val).toBe(0);
  });
});
