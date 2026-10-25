import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import * as priceService from "../src/utils/price-service";
import { __test_resetReferralConfig, __test_setReferralConfig } from "../src/utils/token-registry";
import { SOL, createManager, jupiterQuote } from "./helpers/swap-manager-fixtures";

const jitOptions = (user: Keypair, overrides: Record<string, unknown> = {}) => ({
  userKeypair: user,
  tokenMint: "TokenMint",
  tokenDecimals: 6,
  availableTokenAmountRaw: 20_000_000,
  desiredLamports: 2_000_000,
  tokenTicker: "tkn",
  logContext: "test",
  ...overrides,
});

describe("SwapManager just-in-time flow", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    __test_resetReferralConfig();
  });

  describe("target computation", () => {
    test("does nothing when the wallet already holds enough SOL", async () => {
      const user = await Keypair.generate();
      const { manager } = createManager({ balance: 500_000_000 });
      manager.attemptJupiterSwap = async () => {
        throw new Error("must not swap");
      };

      const result = await manager.performJustInTimeSolSwap(jitOptions(user));

      expect(result).toEqual({ swapped: false });
      const state = await manager.computeTargets({
        userKeypair: user,
        availableTokenAmountRaw: 1,
        desiredLamports: 2_000_000,
        tokenTicker: "TKN",
      });
      expect(state.ok).toBe(true);
      expect(state.value.status).toBe("satisfied");
      expect(state.value.currentLamports).toBe(500_000_000);
    });

    test("returns the insufficient-token message when there is nothing to convert", async () => {
      const user = await Keypair.generate();
      const { manager } = createManager({ balance: 0 });

      const result = await manager.performJustInTimeSolSwap(
        jitOptions(user, { availableTokenAmountRaw: 0 }),
      );

      expect(result).toEqual({
        swapped: false,
        error:
          "Not enough TKN available to convert into SOL for fees. Add SOL manually or deposit additional tokens.",
      });
    });

    test("reports unexpected failures with a safe user message", async () => {
      const user = await Keypair.generate();
      const { manager } = createManager({
        feeBudget: {
          getGameSafetyBufferLamports: async () => {
            throw new Error("fee budget offline");
          },
          getJitSwapFeeBufferLamports: async () => 1,
        },
      });

      const result = await manager.performJustInTimeSolSwap(jitOptions(user));

      expect(result.swapped).toBe(false);
      expect(result.error).toBe("fee budget offline");
      expect(result.userMessage).toContain("Unable to prepare the automatic SOL fee top-up");
      expect(errorSpy).toHaveBeenCalledWith("Just-in-time SOL swap failed:", expect.any(Error));
    });

    test("uses a generic error when the failure carries no message", async () => {
      const user = await Keypair.generate();
      const { manager } = createManager({
        feeBudget: {
          getGameSafetyBufferLamports: async () => {
            throw new Error("");
          },
          getJitSwapFeeBufferLamports: async () => 1,
        },
      });

      const result = await manager.performJustInTimeSolSwap(jitOptions(user));

      expect(result.error).toBe("Failed to perform SOL lending swap");
    });
  });

  describe("user-facing messages per failure type", () => {
    const cases: Array<[string, string, string]> = [
      ["INSUFFICIENT_TOKENS", "custom token message", "custom token message"],
      ["ZERO_LIQUIDITY", "raw", "Jupiter could not find a route for the automatic SOL fee top-up"],
      ["INSUFFICIENT_INPUT", "raw", "The available tokens cannot provide enough SOL for fees"],
      ["SWAP_UNDERSIZED", "raw", "The available tokens cannot provide enough SOL for fees"],
      ["UNWRAP_FAILED", "raw", "Unable to unwrap WSOL for fees"],
      ["PROBE_FAILED", "raw", "Jupiter could not prepare the automatic SOL fee top-up"],
      ["SWAP_EXECUTION_FAILED", "raw", "Jupiter could not prepare the automatic SOL fee top-up"],
    ];

    for (const [type, message, expected] of cases) {
      test(`${type} maps to its user message`, async () => {
        const user = await Keypair.generate();
        const { manager } = createManager({ balance: 0 });
        manager.buildJitIntegrator = async () => null;
        manager.attemptJupiterSwap = async () => ({ status: "error", error: { type, message } });

        const result = await manager.performJustInTimeSolSwap(jitOptions(user));

        expect(result.swapped).toBe(false);
        expect(result.error).toBe(message);
        expect(result.userMessage).toContain(expected);
      });
    }
  });

  describe("WSOL unwrap strategy", () => {
    test("unwraps WSOL with operator sponsorship and an admin integrator", async () => {
      const user = await Keypair.generate();
      const operator = await Keypair.generate();
      __test_setReferralConfig({ referralAccount: "RefAccountKey", baseFeeBps: 120 });
      const priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue({ price: 100 } as any);
      const unwrapCalls: any[] = [];
      try {
        const { manager } = createManager({
          balance: 0,
          operator,
          wallet: {
            unwrapSolWithKeypair: async (args: any) => {
              unwrapCalls.push(args);
              return {
                signature: "unwrap-sig",
                amountLamports: args.amountLamports,
                remainingLamports: 7,
              };
            },
          },
        });

        const result = await manager.performJustInTimeSolSwap(
          jitOptions(user, {
            tokenMint: SOL,
            tokenTicker: "wsol",
            availableTokenAmountRaw: 50_000_000,
          }),
        );

        expect(result).toEqual({
          swapped: true,
          provider: "unwrap",
          signature: "unwrap-sig",
          lamportsReceived: unwrapCalls[0].amountLamports,
        });
        expect(unwrapCalls).toHaveLength(1);
        expect(unwrapCalls[0].adminTopUpLamports).toBe(500_000);
        expect(unwrapCalls[0].operatorKeypair).toBe(operator);
        expect(unwrapCalls[0].owner.equals(user.publicKey)).toBe(true);
      } finally {
        priceSpy.mockRestore();
      }
    });

    test("builds an admin integrator from the referral config", async () => {
      const operator = await Keypair.generate();
      const adminPayer = (await Keypair.generate()).publicKey.toBase58();
      __test_setReferralConfig({
        referralAccount: "RefAccountKey",
        adminPayer,
        adminCloseAuthority: "CloseAuthorityKey",
        baseFeeBps: 120,
        maxExtraFeeBps: 10,
      });
      const priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue({ price: 100 } as any);
      try {
        const { manager } = createManager({ operator });

        const integrator = await manager.buildJitIntegrator({
          tokenMint: "TokenMint",
          tokenDecimals: 6,
          availableTokenAmountRaw: 10_000_000,
          shortfallLamports: 1_000_000,
          tokenTicker: "TKN",
        });

        expect(integrator.referralAccount).toBe("RefAccountKey");
        expect(integrator.payer).toBe(adminPayer);
        expect(integrator.closeAuthority).toBe("CloseAuthorityKey");
        expect(integrator.payerKind).toBe("admin");
        expect(integrator.referralFee).toBeGreaterThanOrEqual(120);
        expect(integrator.referralFee).toBeLessThanOrEqual(130);
      } finally {
        priceSpy.mockRestore();
      }
    });

    test("defaults the integrator payer to the operator key", async () => {
      const operator = await Keypair.generate();
      __test_setReferralConfig({ referralAccount: "RefAccountKey" });
      const priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue(null as any);
      try {
        const { manager } = createManager({ operator });

        const integrator = await manager.buildJitIntegrator({
          tokenMint: "TokenMint",
          tokenDecimals: 6,
          availableTokenAmountRaw: 10_000_000,
          shortfallLamports: 1_000_000,
          tokenTicker: "TKN",
        });

        expect(integrator.payer).toBe(operator.publicKey.toBase58());
        expect(integrator.closeAuthority).toBe(operator.publicKey.toBase58());
        expect(integrator.referralFee).toBe(100);
      } finally {
        priceSpy.mockRestore();
      }
    });

    test("skips the integrator when no operator keypair is available", async () => {
      __test_setReferralConfig({ referralAccount: "RefAccountKey" });
      const { manager } = createManager({ operator: null });

      expect(
        await manager.buildJitIntegrator({
          tokenMint: "TokenMint",
          tokenDecimals: 6,
          availableTokenAmountRaw: 10,
          shortfallLamports: 1,
          tokenTicker: "TKN",
        }),
      ).toBeNull();
    });

    test("reports an unwrap failure when sponsorship needs a missing operator keypair", async () => {
      const user = await Keypair.generate();
      const { manager } = createManager({ balance: 0, operator: null });

      const result = await manager.performJustInTimeSolSwap(
        jitOptions(user, {
          tokenMint: SOL,
          tokenTicker: "wsol",
          availableTokenAmountRaw: 50_000_000,
        }),
      );

      expect(result.swapped).toBe(false);
      expect(result.error).toBe("Operator keypair required when sponsoring WSOL unwrap fees.");
      expect(result.userMessage).toBe(
        "Unable to unwrap WSOL for fees. Add a small amount of SOL manually and try again.",
      );
    });

    test("falls back to a generic unwrap message when every attempt is skipped", async () => {
      const user = await Keypair.generate();
      const { manager } = createManager({ balance: 0 });
      manager.buildJitIntegrator = async () => null;
      manager.attemptWsolUnwrap = async () => ({ status: "skipped" });

      const result = await manager.performJustInTimeSolSwap(
        jitOptions(user, { tokenMint: SOL, tokenTicker: "wsol" }),
      );

      expect(result).toEqual({
        swapped: false,
        error: "Unable to unwrap WSOL for SOL fees. Add SOL manually and try again.",
        userMessage: "Unable to unwrap WSOL for SOL fees. Add SOL manually and try again.",
      });
    });

    test("skips the unwrap when there is nothing to unwrap", async () => {
      const user = await Keypair.generate();
      const { manager } = createManager();

      const result = await manager.attemptWsolUnwrap({
        target: 1_000_000,
        availableRaw: 0,
        currentLamports: 0,
        jitFeeBuffer: 500_000,
        userKeypair: user,
        logContext: "test",
      });

      expect(result).toEqual({ status: "skipped" });
    });

    test("surfaces wallet failures as unwrap errors, with a default message", async () => {
      const user = await Keypair.generate();
      const { manager, wallet } = createManager({
        wallet: {
          unwrapSolWithKeypair: async () => {
            throw new Error("");
          },
        },
      });
      expect(wallet).toBeDefined();

      const result = await manager.attemptWsolUnwrap({
        target: 1_000_000,
        availableRaw: 5_000_000,
        currentLamports: 900_000,
        jitFeeBuffer: 500_000,
        userKeypair: user,
        logContext: "test",
      });

      expect(result.status).toBe("error");
      expect(result.error.type).toBe("UNWRAP_FAILED");
      expect(result.error.message).toBe(
        "Unable to unwrap WSOL automatically. Add SOL manually and try again.",
      );
    });
  });

  describe("unwrapWsolPortion validation", () => {
    test("rejects non-positive and unsafe unwrap amounts", async () => {
      const user = await Keypair.generate();
      const operator = await Keypair.generate();
      const { manager } = createManager();

      await expect(
        manager.unwrapWsolPortion({ userKeypair: user, unwrapLamports: 0, logContext: "t" }),
      ).rejects.toThrow("Unwrap amount must be greater than zero.");
      await expect(
        manager.unwrapWsolPortion({
          userKeypair: user,
          unwrapLamports: Number.NaN,
          logContext: "t",
        }),
      ).rejects.toThrow("Unwrap amount must be greater than zero.");
      await expect(
        manager.unwrapWsolPortion({
          userKeypair: user,
          unwrapLamports: 2 ** 60,
          logContext: "t",
          operatorKeypair: operator,
          lendingLamports: 10,
        }),
      ).rejects.toThrow("Unwrap amount must be a safe integer in lamports.");
    });
  });

  describe("Jupiter swap step", () => {
    const swapArgs = async () => ({
      targetLamportsOut: 1_000_000,
      availableRawBig: 50_000_000n,
      availableTokenAmountRaw: 50_000_000,
      userKeypair: await Keypair.generate(),
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      tokenTicker: "TKN",
      integrator: null,
      shortfallLamports: 1_000_000,
    });

    test("returns the probe error without executing a swap", async () => {
      const { manager } = createManager();
      const probeError = { type: "ZERO_LIQUIDITY", message: "no route" };
      manager.probePriceAndSizeInput = async () => ({ ok: false, error: probeError });
      manager.executeSwap = async () => {
        throw new Error("must not execute");
      };

      expect(await manager.attemptJupiterSwap(await swapArgs())).toEqual({
        status: "error",
        error: probeError,
      });
    });

    test("wraps execution failures, using a default message when none is given", async () => {
      const { manager } = createManager();
      const failure = new Error("");
      manager.swapService = {
        execute: async () => {
          throw failure;
        },
      };

      const result = await manager.executeSwap({
        swapQuote: { inputMint: "TokenMint" },
        userKeypair: await Keypair.generate(),
        targetLamportsOut: 1_000_000,
      });

      expect(result).toEqual({
        status: "error",
        error: {
          type: "SWAP_EXECUTION_FAILED",
          message: "Jupiter route unavailable. Try again or add SOL manually.",
          cause: failure,
        },
      });
    });

    test("probe fails when the computed input is zero", async () => {
      const { manager } = createManager();
      manager.getJupiterQuote = async () => jupiterQuote();
      manager.swapService = {
        prepareSwap: async () => {
          throw new Error("must not prepare");
        },
      };

      const result = await manager.probePriceAndSizeInput({
        ...(await swapArgs()),
        targetLamportsOut: 0,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toEqual({
        type: "INSUFFICIENT_INPUT",
        message: "Computed swap input was zero. Add SOL manually.",
      });
    });

    test("probe fails when the prepared swap would return too little SOL", async () => {
      const { manager } = createManager();
      manager.getJupiterQuote = async () => jupiterQuote();
      manager.swapService = {
        prepareSwap: async () => ({
          providerQuote: { outAmount: "999999" },
          outputAmount: "999999",
        }),
      };

      const result = await manager.probePriceAndSizeInput(await swapArgs());

      expect(result.ok).toBe(false);
      expect(result.error.type).toBe("SWAP_UNDERSIZED");
    });

    test("probe returns the prepared quote when it meets the target", async () => {
      const { manager } = createManager();
      manager.getJupiterQuote = async () => jupiterQuote();
      const prepared = { providerQuote: { outAmount: "1000000" }, outputAmount: "1000000" };
      manager.swapService = { prepareSwap: async () => prepared };

      const result = await manager.probePriceAndSizeInput(await swapArgs());

      expect(result).toEqual({ ok: true, value: { swapQuote: prepared } });
    });

    test("probe failures keep the provider message, or a default when it is empty", async () => {
      const { manager } = createManager();
      manager.getJupiterQuote = async () => {
        throw new Error("rate limited");
      };
      const withMessage = await manager.probePriceAndSizeInput(await swapArgs());
      expect(withMessage.error.type).toBe("PROBE_FAILED");
      expect(withMessage.error.message).toBe("rate limited");

      manager.getJupiterQuote = async () => {
        throw new Error("");
      };
      const withoutMessage = await manager.probePriceAndSizeInput(await swapArgs());
      expect(withoutMessage.error.message).toBe(
        "Jupiter route unavailable. Try again or add SOL manually.",
      );
    });
  });

  describe("synthetic wrap and unwrap execution", () => {
    const request = async () => ({ userKeypair: await Keypair.generate() });

    test("rejects wrap amounts that are zero or beyond the safe range", async () => {
      const { manager } = createManager();

      await expect(
        manager.executeWrapSwap(await request(), { inputAmountRaw: "0" }),
      ).rejects.toThrow("Wrap amount must be greater than zero.");
      await expect(
        manager.executeWrapSwap(await request(), { inputAmountRaw: String(2n ** 60n) }),
      ).rejects.toThrow("Wrap amount must be a safe integer in lamports.");
    });

    test("rejects unwrap amounts that are zero or beyond the safe range", async () => {
      const { manager } = createManager();

      await expect(
        manager.executeUnwrapSwap(await request(), { inputAmountRaw: "0" }),
      ).rejects.toThrow("Unwrap amount must be greater than zero.");
      await expect(
        manager.executeUnwrapSwap(await request(), { inputAmountRaw: String(2n ** 60n) }),
      ).rejects.toThrow("Unwrap amount must be a safe integer in lamports.");
    });
  });
});
