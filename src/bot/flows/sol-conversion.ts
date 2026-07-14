import type { WalletManager } from "../../utils/wallet";
import type { SwapQuote } from "../../utils/swap-manager";
import type { buildTransactionLinkMessage } from "../../utils/network-detector";
import type { getPendingTransaction } from "../../utils/user-state";
import { INPUT_TIMEOUT_MS } from "../../utils/constants";

export type SolConversionValidationResult =
  | { status: "ok"; formattedAmount?: string }
  | { status: "insufficient"; formattedAmount: string }
  | { status: "empty"; formattedAmount?: string };

export type SolConversionFlowOutcome =
  | { status: "success"; signature: string; formattedAmount: string }
  | { status: "insufficient"; formattedAmount: string }
  | { status: "empty"; formattedAmount?: string }
  | { status: "error" };

export interface SolConversionFlowConfig {
  telegramId: bigint;
  ensureProceed: () => Promise<SolConversionValidationResult>;
  perform: () => Promise<{ signature: string; amountLamports?: number }>;
  onProcessing: (formattedAmount?: string) => Promise<void>;
  onSuccess: (details: {
    signature: string;
    formattedAmount: string;
    solscanUrl?: string | null;
  }) => Promise<void>;
  onInsufficient?: (formattedAmount: string) => Promise<void>;
  onEmpty?: (formattedAmount?: string) => Promise<void>;
  onError?: (error: unknown, formattedAmount?: string) => Promise<void>;
  formatAmount: (lamports: number) => string;
  initialAmountLamports?: number;
  treatZeroAmountAsEmpty?: boolean;
  handleEmptyError?: (error: unknown) => boolean;
  networkOverride?: string | null;
}

export type WrapFlowResult = {
  status: "success" | "insufficient" | "error";
  signature?: string;
};

export type WrapFlowHandlers = {
  onProcessing: (formattedAmount: string) => Promise<void>;
  onSuccess: (details: {
    signature: string;
    formattedAmount: string;
    solscanUrl?: string | null;
  }) => Promise<void>;
  onInsufficientBalance: (formattedAmount: string) => Promise<void>;
  onError?: (error: unknown, formattedAmount: string) => Promise<void>;
};

export type UnwrapFlowResult = {
  status: "success" | "empty" | "error";
  signature?: string;
  formattedAmount?: string;
};

export type UnwrapFlowHandlers = {
  expectedAmountLamports?: number;
  unwrapLamports?: number;
  onProcessing: (formattedAmount?: string) => Promise<void>;
  onNoBalance: () => Promise<void>;
  onSuccess: (details: {
    signature: string;
    formattedAmount: string;
    solscanUrl?: string | null;
  }) => Promise<void>;
  onError?: (error: unknown) => Promise<void>;
};

export type PendingTransactionValidationResult<T> =
  { status: "success"; transaction: T } | { status: "expired" } | { status: "unauthorized" };

export type PendingSendTransaction = {
  type: "send";
  userId: string;
  token: string;
  amount: string;
  address: string;
  amountDisplay?: string;
};

export type PendingSwapTransaction = {
  type: "swap";
  userId: string;
  fromToken: string;
  toToken: string;
  amount: string;
  rawAmount: string;
  inputDecimals: number;
  outputDecimals: number;
  cancelCallback: string;
  quote: SwapQuote;
};

export type CreateSolConversionUtilitiesOptions = {
  wallet: WalletManager;
  clearWalletCache: (telegramId: bigint) => void;
  buildTransactionLinkMessage: typeof buildTransactionLinkMessage;
  getPendingTransaction: typeof getPendingTransaction;
  getSolFeeBufferLamports: () => number;
};

export const createSolConversionUtilities = ({
  wallet,
  clearWalletCache,
  buildTransactionLinkMessage,
  getPendingTransaction,
  getSolFeeBufferLamports,
}: CreateSolConversionUtilitiesOptions) => {
  const executeSolConversionFlow = async ({
    telegramId,
    ensureProceed,
    perform,
    onProcessing,
    onSuccess,
    onInsufficient,
    onEmpty,
    onError,
    formatAmount,
    initialAmountLamports,
    treatZeroAmountAsEmpty = false,
    handleEmptyError,
    networkOverride,
  }: SolConversionFlowConfig): Promise<SolConversionFlowOutcome> => {
    const validation = await ensureProceed();

    if (validation.status === "insufficient") {
      await onInsufficient?.(validation.formattedAmount);
      return { status: "insufficient", formattedAmount: validation.formattedAmount };
    }

    if (validation.status === "empty") {
      await onEmpty?.(validation.formattedAmount);
      return { status: "empty", formattedAmount: validation.formattedAmount };
    }

    const processingAmount =
      validation.formattedAmount ??
      (initialAmountLamports !== undefined ? formatAmount(initialAmountLamports) : undefined);

    await onProcessing(processingAmount);

    let formattedAmountForError = processingAmount;

    try {
      const { signature, amountLamports } = await perform();
      const normalizedAmount =
        amountLamports !== undefined ? amountLamports : initialAmountLamports;

      if (normalizedAmount === undefined) {
        if (treatZeroAmountAsEmpty) {
          await onEmpty?.(validation.formattedAmount);
          return { status: "empty", formattedAmount: validation.formattedAmount };
        }
        throw new Error("Unable to determine transaction amount");
      }

      if (!Number.isFinite(normalizedAmount)) {
        throw new Error("Invalid transaction amount");
      }

      if (treatZeroAmountAsEmpty && normalizedAmount <= 0) {
        await onEmpty?.(validation.formattedAmount);
        return { status: "empty", formattedAmount: validation.formattedAmount };
      }

      const formattedAmount = formatAmount(normalizedAmount);
      formattedAmountForError = formattedAmount;

      await wallet.confirmTransaction(signature);
      clearWalletCache(telegramId);

      const { solscanUrl } = buildTransactionLinkMessage({
        signature,
        networkOverride: networkOverride ?? process.env["RPC_URL"],
      });

      await onSuccess({ signature, formattedAmount, solscanUrl });
      return { status: "success", signature, formattedAmount };
    } catch (error) {
      if (handleEmptyError?.(error)) {
        await onEmpty?.(validation.formattedAmount);
        return { status: "empty", formattedAmount: validation.formattedAmount };
      }

      if (onError) {
        await onError(error, formattedAmountForError ?? validation.formattedAmount);
        return { status: "error" };
      }

      throw error;
    }
  };

  const executeWrapFlow = async (
    telegramId: bigint,
    amountLamports: number,
    handlers: WrapFlowHandlers,
  ): Promise<WrapFlowResult> => {
    if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
      throw new Error("Wrap amount must be greater than zero");
    }

    const result = await executeSolConversionFlow({
      telegramId,
      initialAmountLamports: amountLamports,
      formatAmount: (lamports) => wallet.formatSolBalance(lamports),
      ensureProceed: async () => {
        const formattedAmount = wallet.formatSolBalance(amountLamports);
        const balanceLamports = await wallet.getBalance(telegramId);
        const feeBuffer = getSolFeeBufferLamports();

        if (amountLamports + feeBuffer > balanceLamports) {
          return { status: "insufficient", formattedAmount } as const;
        }

        return { status: "ok", formattedAmount } as const;
      },
      perform: async () => ({
        signature: await wallet.wrapSol(telegramId, amountLamports),
        amountLamports,
      }),
      onProcessing: async (amount) =>
        handlers.onProcessing(amount ?? wallet.formatSolBalance(amountLamports)),
      onSuccess: handlers.onSuccess,
      onInsufficient: handlers.onInsufficientBalance,
      onError: handlers.onError
        ? (error, formattedAmount) =>
            handlers.onError!(error, formattedAmount ?? wallet.formatSolBalance(amountLamports))
        : undefined,
    });

    if (result.status === "success") {
      return { status: "success", signature: result.signature };
    }

    if (result.status === "insufficient") {
      return { status: "insufficient" };
    }

    if (result.status === "error") {
      return { status: "error" };
    }

    return { status: "error" };
  };

  const executeUnwrapFlow = async (
    telegramId: bigint,
    handlers: UnwrapFlowHandlers,
  ): Promise<UnwrapFlowResult> => {
    const targetLamports = handlers.unwrapLamports ?? handlers.expectedAmountLamports;

    const result = await executeSolConversionFlow({
      telegramId,
      formatAmount: (lamports) => wallet.formatSolBalance(lamports),
      ensureProceed: async () => {
        const expected = handlers.expectedAmountLamports;
        if (expected !== undefined) {
          if (!Number.isFinite(expected) || expected <= 0) {
            return { status: "empty" } as const;
          }

          return {
            status: "ok",
            formattedAmount: wallet.formatSolBalance(expected),
          } as const;
        }

        return { status: "ok" } as const;
      },
      perform: async () => wallet.unwrapSol(telegramId, targetLamports),
      onProcessing: handlers.onProcessing,
      onSuccess: handlers.onSuccess,
      onEmpty: handlers.onNoBalance,
      onError: handlers.onError ? (error) => handlers.onError!(error) : undefined,
      treatZeroAmountAsEmpty: true,
      handleEmptyError: (error) => {
        const message = error instanceof Error ? (error.message ?? "") : String(error ?? "");
        return (
          message.includes("already empty") ||
          message.includes("No WSOL account") ||
          message.includes("WSOL account is already empty")
        );
      },
    });

    if (result.status === "success") {
      return {
        status: "success",
        signature: result.signature,
        formattedAmount: result.formattedAmount,
      };
    }

    if (result.status === "empty") {
      return { status: "empty", formattedAmount: result.formattedAmount };
    }

    if (result.status === "error") {
      return { status: "error" };
    }

    return { status: "error" };
  };

  const validatePendingTransaction = <T extends { type: string; userId: string }>(
    ctx: {
      chat?: { id?: number | string | bigint } | undefined;
      from?: { id?: number | string | bigint } | undefined;
    },
    txId: string,
    expectedType: T["type"],
    options: {
      removeFromCache?: boolean;
      timeoutMs?: number;
      now?: number;
    } = {},
  ): PendingTransactionValidationResult<T> => {
    const { removeFromCache = true, timeoutMs = INPUT_TIMEOUT_MS, now = Date.now() } = options;

    const entry = getPendingTransaction(txId, false) as
      (T & { type: string; userId: string; timestamp?: number }) | undefined;

    if (!entry || entry.type !== expectedType) {
      getPendingTransaction(txId, true);
      return { status: "expired" };
    }

    const { timestamp, ...transaction } = entry;
    const entryTimestamp =
      typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;

    if (
      entryTimestamp !== undefined &&
      Number.isFinite(entryTimestamp) &&
      timeoutMs > 0 &&
      now - entryTimestamp > timeoutMs
    ) {
      getPendingTransaction(txId, true);
      return { status: "expired" };
    }

    const telegramId = ctx?.from?.id ?? ctx?.chat?.id;
    if (telegramId == null || entry.userId !== String(telegramId)) {
      return { status: "unauthorized" };
    }

    if (removeFromCache) {
      getPendingTransaction(txId, true);
    }

    return { status: "success", transaction: transaction as T };
  };

  return {
    executeWrapFlow,
    executeUnwrapFlow,
    validatePendingTransaction,
  };
};
