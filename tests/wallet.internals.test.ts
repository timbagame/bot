import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMintEncoder as getMint2022Encoder } from "@solana-program/token-2022";
import { Keypair, PublicKey, SystemProgram } from "#solana";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "#token";
import { WalletManager } from "../src/utils/wallet";
import * as recovery from "../src/utils/game-creation-recovery";
import { RpcRetryLaterError } from "../src/utils/rpc-request-budget";
import { TokenManager } from "../src/utils/token-manager";

const MNEMONIC = process.env.MNEMONIC!;
const none = { __option: "None" } as const;
const some = <T>(value: T) => ({ __option: "Some", value }) as const;

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const walletWith = (connection: Record<string, unknown>) =>
  WalletManager.createForTest(MNEMONIC, {
    connection: { rpcEndpoint: "http://localhost:8899", ...connection } as any,
  });

describe("fee estimation", () => {
  const transfer = async () => {
    const from = (await Keypair.generate()).publicKey;
    return {
      payer: from,
      instruction: SystemProgram.transfer({ fromPubkey: from, toPubkey: from, lamports: 1 }),
    };
  };
  const blockhash = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 };

  test("costs nothing without instructions", async () => {
    const wallet = walletWith({});
    expect(await (wallet as any).estimateFee(PublicKey.default, [])).toBe(0);
  });

  test("asks the RPC for the fee of the compiled message", async () => {
    const getFeeForMessage = mock(async () => ({ value: 7_500n }));
    const wallet = walletWith({ getLatestBlockhash: async () => blockhash, getFeeForMessage });
    const { payer, instruction } = await transfer();

    expect(await (wallet as any).estimateFee(payer, [instruction])).toBe(7_500);
    expect(getFeeForMessage).toHaveBeenCalledTimes(1);
  });

  test("falls back to 5000 lamports when the RPC has no estimate", async () => {
    const wallet = walletWith({
      getLatestBlockhash: async () => blockhash,
      getFeeForMessage: async () => ({ value: null }),
    });
    const { payer, instruction } = await transfer();

    expect(await (wallet as any).estimateFee(payer, [instruction])).toBe(5_000);
    expect(warnSpy.mock.calls[0]?.[0]).toBe("⚠️ Failed to estimate fee, falling back to default:");
  });

  test("refuses to guess when a fallback is not allowed", async () => {
    const wallet = walletWith({
      getLatestBlockhash: async () => blockhash,
      getFeeForMessage: async () => {
        throw new Error("rpc down");
      },
    });
    const { payer, instruction } = await transfer();

    await expect(
      (wallet as any).estimateFee(payer, [instruction], { allowFallback: false }),
    ).rejects.toThrow("Unable to estimate the sponsored transaction fee.");
  });
});

describe("default game transaction sender", () => {
  test("broadcasts base64 transactions with preflight and retries", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ jsonrpc: "2.0", id: bodies.at(-1).id, result: "broadcast-sig" });
    }) as unknown as typeof fetch;
    try {
      const wallet = walletWith({});

      const signature = await (wallet as any).sendGameTransaction("http://rpc.test", "AQID");

      expect(signature).toBe("broadcast-sig");
      expect(bodies[0].method).toBe("sendTransaction");
      expect(bodies[0].params[0]).toBe("AQID");
      expect(bodies[0].params[1]).toMatchObject({
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("operator keypair location", () => {
  const saved = {
    operator: process.env.OPERATOR_KEYPAIR_PATH,
    admin: process.env.ADMIN_KEYPAIR_PATH,
    cwd: process.cwd(),
  };
  let directory: string;
  const writeKey = async (file: string, mode = 0o600) => {
    const keypair = await Keypair.generate();
    writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)));
    chmodSync(file, mode);
    return keypair;
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "operator-key-"));
    delete process.env.OPERATOR_KEYPAIR_PATH;
    delete process.env.ADMIN_KEYPAIR_PATH;
  });
  afterEach(() => {
    process.chdir(saved.cwd);
    if (saved.operator === undefined) delete process.env.OPERATOR_KEYPAIR_PATH;
    else process.env.OPERATOR_KEYPAIR_PATH = saved.operator;
    if (saved.admin === undefined) delete process.env.ADMIN_KEYPAIR_PATH;
    else process.env.ADMIN_KEYPAIR_PATH = saved.admin;
    rmSync(directory, { recursive: true, force: true });
  });

  test("reads OPERATOR_KEYPAIR_PATH and caches the key", async () => {
    const keypair = await writeKey(join(directory, "custom.json"));
    process.env.OPERATOR_KEYPAIR_PATH = ` ${join(directory, "custom.json")} `;
    const wallet = walletWith({});

    const loaded = await wallet.getOperatorKeypair();

    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    rmSync(join(directory, "custom.json"));
    expect(await wallet.getOperatorKeypair()).toBe(loaded);
  });

  test("falls back to ADMIN_KEYPAIR_PATH", async () => {
    const keypair = await writeKey(join(directory, "admin.json"));
    process.env.ADMIN_KEYPAIR_PATH = join(directory, "admin.json");

    expect((await walletWith({}).getOperatorKeypair()).publicKey.toBase58()).toBe(
      keypair.publicKey.toBase58(),
    );
  });

  test("prefers operator-keypair.json in the working directory", async () => {
    const keypair = await writeKey(join(directory, "operator-keypair.json"));
    process.chdir(directory);

    expect((await walletWith({}).getOperatorKeypair()).publicKey.toBase58()).toBe(
      keypair.publicKey.toBase58(),
    );
  });

  test("rejects keys readable by other users", async () => {
    await writeKey(join(directory, "open.json"), 0o644);
    process.env.OPERATOR_KEYPAIR_PATH = join(directory, "open.json");

    const error = await walletWith({})
      .getOperatorKeypair()
      .catch((caught) => caught);

    expect(error.message).toContain("Failed to load operator keypair");
    expect(error.cause.message).toContain("insecure permissions (644)");
  });

  test("path replacement after inspection cannot substitute an operator key", async () => {
    const file = join(directory, "original.json");
    const original = await writeKey(file);
    const replacement = join(directory, "replacement.json");
    await writeKey(replacement, 0o644);
    process.env.OPERATOR_KEYPAIR_PATH = file;
    const swap = () => {
      fs.renameSync(file, `${file}-old`);
      fs.symlinkSync(replacement, file);
    };
    const realLstat = fs.lstatSync;
    const realFstat = fs.fstatSync;
    const pathHook = spyOn(fs, "lstatSync").mockImplementationOnce(((file: fs.PathLike) => {
      const stats = realLstat(file);
      swap();
      return stats;
    }) as typeof fs.lstatSync);
    const descriptorHook = spyOn(fs, "fstatSync").mockImplementationOnce(((fd: number) => {
      const stats = realFstat(fd);
      swap();
      return stats;
    }) as typeof fs.fstatSync);
    try {
      expect((await walletWith({}).getOperatorKeypair()).publicKey.toBase58()).toBe(
        original.publicKey.toBase58(),
      );
    } finally {
      pathHook.mockRestore();
      descriptorHook.mockRestore();
    }
  });
});

describe("RPC endpoint listeners", () => {
  test("registration is ignored without an endpoint manager", () => {
    const wallet = walletWith({});
    (wallet as any).rpcEndpointManager = undefined;

    const unsubscribe = wallet.onRpcEndpointChange(() => {});

    expect(typeof unsubscribe).toBe("function");
    expect(unsubscribe()).toBeUndefined();
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      "RPC endpoint manager is not available; listener registration ignored.",
    );
  });

  test("delegates to the endpoint manager", () => {
    const wallet = walletWith({});
    const unsubscribe = () => {};
    const onActiveEndpointChange = mock(() => unsubscribe);
    (wallet as any).rpcEndpointManager = { onActiveEndpointChange };
    const listener = () => {};

    expect(wallet.onRpcEndpointChange(listener)).toBe(unsubscribe);
    expect(onActiveEndpointChange).toHaveBeenCalledWith(listener);
  });

  test("wallet cache listeners can unsubscribe", () => {
    const wallet = walletWith({});
    const seen: unknown[] = [];
    const unsubscribe = wallet.onWalletCacheCleared((id) => seen.push(id));

    wallet.clearCachedWalletData(1n);
    unsubscribe();
    wallet.clearCachedWalletData(2n);

    expect(seen).toEqual([1n]);
  });
});

describe("unknown tokens found in a wallet", () => {
  const loader = { load: async () => ({ decimals: 6, symbol: "NEW" }) };

  test("are registered and added to the known tokens", async () => {
    const register = spyOn(TokenManager, "getInstance").mockReturnValue({
      registerTokenIfNeeded: async (input: any) => {
        expect(await input.metadataResolvers[0]()).toEqual({ decimals: 6, symbol: "NEW" });
        return { token: { token_mint: "M", token_ticker: "NEW", decimals: 6 } };
      },
    } as any);
    try {
      const known = new Map<string, any>();
      await (walletWith({}) as any).autoRegisterTokenForBalance("M", known, loader);
      expect(known.get("M")).toEqual({
        token_mint: "M",
        token_ticker: "NEW",
        decimals: 6,
        token_program_id: null,
      });
    } finally {
      register.mockRestore();
    }
  });

  test("are skipped when registration fails or throws", async () => {
    const known = new Map<string, any>();
    const failed = spyOn(TokenManager, "getInstance").mockReturnValue({
      registerTokenIfNeeded: async () => ({ token: null, resolvedTicker: "BAD" }),
    } as any);
    try {
      await (walletWith({}) as any).autoRegisterTokenForBalance("M", known, loader);
      expect(
        logSpy.mock.calls.some((call: unknown[]) => call[0] === "❌ Failed to auto-register: BAD"),
      ).toBe(true);
    } finally {
      failed.mockRestore();
    }
    const throwing = spyOn(TokenManager, "getInstance").mockReturnValue({
      registerTokenIfNeeded: async () => {
        throw new Error("db locked");
      },
    } as any);
    try {
      await (walletWith({}) as any).autoRegisterTokenForBalance("M", known, loader);
      expect(errorSpy.mock.calls[0]?.[0]).toBe("❌ Error auto-registering token M:");
    } finally {
      throwing.mockRestore();
    }
    expect(known.size).toBe(0);
  });

  test("invalid raw amounts are reported and ignored", () => {
    expect((walletWith({}) as any).parseLamports("1.5", "M")).toBeNull();
    expect(errorSpy.mock.calls[0]?.[0]).toBe("❌ Invalid lamport amount for M: 1.5");
  });
});

describe("Token-2022 transfer safety", () => {
  const mintAccount = (extensions: unknown[]) => ({
    owner: TOKEN_2022_PROGRAM_ID,
    data: Uint8Array.from(
      getMint2022Encoder().encode({
        mintAuthority: none,
        supply: 0n,
        decimals: 6,
        isInitialized: true,
        freezeAuthority: none,
        extensions: some(extensions),
      } as any),
    ),
  });
  const walletForMint = (account: unknown) => {
    const wallet = walletWith({ getAccountInfo: async () => account });
    (wallet as any).resolveTokenProgram = async () => ({ isToken2022: true });
    return wallet;
  };
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const key = PublicKey.default.toBase58();

  test("classic SPL tokens have no warnings", async () => {
    const wallet = walletWith({});
    (wallet as any).resolveTokenProgram = async () => ({ isToken2022: false });

    expect(await wallet.getTokenTransferSafety(MINT)).toEqual({ warnings: [] });
  });

  test("warns about delegates, fees and frozen defaults", async () => {
    const wallet = walletForMint(
      mintAccount([
        { __kind: "PermanentDelegate", delegate: key },
        {
          __kind: "TransferFeeConfig",
          transferFeeConfigAuthority: key,
          withdrawWithheldAuthority: key,
          withheldAmount: 0n,
          olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
          newerTransferFee: { epoch: 0n, maximumFee: 10n, transferFeeBasisPoints: 250 },
        },
        { __kind: "DefaultAccountState", state: 2 },
      ]),
    );

    expect(await wallet.getTokenTransferWarnings(MINT)).toEqual([
      "This token has a permanent delegate that can transfer or burn balances.",
      "This token charges a transfer fee of up to 2.5%.",
      "New accounts for this token are frozen by default.",
    ]);
  });

  test("blocks transfer hooks and non-transferable tokens", async () => {
    expect(
      await walletForMint(
        mintAccount([{ __kind: "TransferHook", authority: key, programId: key }]),
      ).getTokenTransferSafety(MINT),
    ).toEqual({
      warnings: [],
      blockedReason: "Transfers for this token use a hook that the wallet does not support.",
    });
    expect(
      await walletForMint(mintAccount([{ __kind: "NonTransferable" }])).getTokenTransferSafety(
        MINT,
      ),
    ).toEqual({ warnings: [], blockedReason: "This token is non-transferable." });
  });

  test("rejects a mint that is not owned by Token-2022", async () => {
    await expect(walletForMint(null).getTokenTransferSafety(MINT)).rejects.toThrow(
      "Invalid Token-2022 mint account",
    );
    await expect(
      walletForMint({ ...mintAccount([]), owner: TOKEN_PROGRAM_ID }).getTokenTransferSafety(MINT),
    ).rejects.toThrow("Invalid Token-2022 mint account");
  });
});

describe("ensureAssociatedTokenAccount", () => {
  test("reports the mint's token program and whether the account must be created", async () => {
    const owner = (await Keypair.generate()).publicKey;
    const mint = (await Keypair.generate()).publicKey;
    const payer = await Keypair.generate();
    const wallet = walletWith({
      getAccountInfo: async (address: PublicKey) =>
        address.equals(mint) ? { owner: TOKEN_2022_PROGRAM_ID, data: new Uint8Array(82) } : null,
    });

    const result = await wallet.ensureAssociatedTokenAccount(owner, mint, payer);

    expect(result.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(result).toMatchObject({ isToken2022: true, created: true });
    expect(result.instructions).toHaveLength(1);
  });

  test("rejects a mint that does not exist", async () => {
    const mint = (await Keypair.generate()).publicKey;
    const wallet = walletWith({ getAccountInfo: async () => null });

    await expect(
      wallet.ensureAssociatedTokenAccount(PublicKey.default, mint, await Keypair.generate()),
    ).rejects.toThrow(`Token mint ${mint.toBase58()} was not found`);
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("Unsupported token mint"),
      ),
    ).toBe(true);
  });
});

describe("proving an expired game creation never landed", () => {
  const proveWith = (endpoints: string[]) => {
    const wallet = Object.create(WalletManager.prototype) as any;
    wallet.gameRecoveryEndpointsWithFallback = async () => endpoints;
    wallet.recoveryRpc = () => async () => null;
    return wallet as WalletManager;
  };
  const input = {} as any;

  test("needs a primary endpoint and an independent witness", async () => {
    expect(await proveWith([]).proveGameCreationAbsent(input)).toBe(false);
    expect(
      await proveWith(["https://a.rpc.test/1", "https://a.rpc.test/2"]).proveGameCreationAbsent(
        input,
      ),
    ).toBe(false);
  });

  test("returns the proof from two different providers and bounds the scan", async () => {
    const prove = spyOn(recovery, "proveExpiredCreationAbsent").mockResolvedValue(true);
    try {
      const progress = { checkpoint: 1 } as any;
      expect(
        await proveWith(["https://a.rpc.test", "https://b.rpc.test"]).proveGameCreationAbsent(
          input,
          progress,
        ),
      ).toBe(true);
      expect((prove.mock.calls[0] as any[])[3]).toEqual({ checkpoint: 1, maxBlocks: 20 });
    } finally {
      prove.mockRestore();
    }
  });

  test("keeps the checkpoint for transport failures and rate limits", async () => {
    const endpoints = ["https://a.rpc.test", "https://b.rpc.test"];
    const limited = new RpcRetryLaterError("slow down", Date.now() + 1_000);
    for (const [thrown, expected] of [
      [limited, limited],
      [new TypeError("fetch failed"), "Recovery RPC interrupted; checkpoint retained"],
      [new SyntaxError("bad json"), "Recovery RPC interrupted; checkpoint retained"],
    ] as const) {
      const prove = spyOn(recovery, "proveExpiredCreationAbsent").mockRejectedValue(thrown);
      try {
        const error = await proveWith(endpoints)
          .proveGameCreationAbsent(input)
          .catch((caught) => caught);
        expect(error).toBeInstanceOf(RpcRetryLaterError);
        if (typeof expected === "string") expect(error.message).toBe(expected);
        else expect(error).toBe(expected);
      } finally {
        prove.mockRestore();
      }
    }
  });

  test("other proof failures mean the absence is unproven", async () => {
    const prove = spyOn(recovery, "proveExpiredCreationAbsent").mockRejectedValue(
      new Error("inconsistent history"),
    );
    try {
      expect(
        await proveWith(["https://a.rpc.test", "https://b.rpc.test"]).proveGameCreationAbsent(
          input,
        ),
      ).toBe(false);
    } finally {
      prove.mockRestore();
    }
  });
});

describe("confirming game creations through fallback endpoints", () => {
  const setup = (alternate: unknown) => {
    const wallet = walletWith({
      getSignatureStatuses: async () => ({ value: [null] }),
      getBlockHeight: async () => 0,
      getTransaction: async () => null,
    }) as any;
    wallet.confirmationTimeoutMs = 5;
    wallet.signaturePollIntervalMs = 1;
    wallet.postTimeoutProbeBackoffMs = 0;
    wallet.pendingSignatures.set("game-sig", {
      blockhash: "x",
      lastValidBlockHeight: 1_000_000,
      recordedAt: Date.now(),
      gameCreation: true,
    });
    const asked: string[] = [];
    wallet.gameRecoveryEndpointsWithFallback = async () => [
      "http://localhost:8899",
      "https://alt.rpc.test",
    ];
    wallet.recoveryRpc = (endpoint: string) => async (method: string) => {
      asked.push(`${endpoint} ${method}`);
      return { value: [alternate] };
    };
    return { wallet: wallet as WalletManager, asked };
  };

  test("a confirmed status on another endpoint confirms the creation", async () => {
    const { wallet, asked } = setup({ confirmationStatus: "finalized" });

    await expect(wallet.confirmTransaction("game-sig")).resolves.toBeUndefined();
    expect(asked).toEqual(["https://alt.rpc.test getSignatureStatuses"]);
  });

  test("an unconfirmed fallback status leaves the outcome unknown", async () => {
    const { wallet, asked } = setup({ confirmationStatus: "processed" });

    await expect(wallet.confirmTransaction("game-sig")).rejects.toThrow();
    expect(asked.length).toBeGreaterThan(0);
  });
});
