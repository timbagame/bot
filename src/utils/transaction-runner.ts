import type { WalletManager } from "./wallet";
import { TRANSACTION_RESUBMIT_ATTEMPTS } from "./constants";

const CONFIRMATION_RETRY_DELAYS_MS = [2000, 4000, 8000, 12000, 16000, 20000];

const isTestEnv = () => (process.env.NODE_ENV ?? "").toLowerCase() === "test";

export const getConfirmationRetryDelays = (): number[] => {
  if (isTestEnv()) {
    return new Array(CONFIRMATION_RETRY_DELAYS_MS.length).fill(0);
  }
  return CONFIRMATION_RETRY_DELAYS_MS;
};

type ErrorWithCause = Error & { cause?: unknown };
type ErrorWithLastSignature = Error & { lastSignature?: string };
type TimeoutErrorWithRecovery = ErrorWithCause & { recoveryErrors?: Error[] };

const hasLastSignature = (error: unknown): error is ErrorWithLastSignature =>
  typeof error === "object" &&
  error !== null &&
  "lastSignature" in error &&
  typeof (error as { lastSignature?: unknown }).lastSignature === "string";

export type TransactionProbe = {
  label: string;
  check: () => Promise<boolean>;
};

type ConfirmTransactionWithRecoveryOptions = {
  wallet: WalletManager;
  initialSignature: string;
  operationLabel: string;
  /**
   * Optional callback to resubmit the transaction.
   *
   * `attempt` is zero-based: the first resubmission call receives `0`.
   */
  resubmit?: (attempt: number, previousSignature: string) => Promise<string>;
  probes?: TransactionProbe[];
  retryDelays?: number[];
  logger?: (...args: unknown[]) => void;
};

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

type SignatureStatusLike = {
  err?: unknown;
  confirmationStatus?: string;
  confirmations?: number | null;
};

type SignatureStatusConnectionLike = {
  getSignatureStatuses?: (
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ) => Promise<{ value?: Array<SignatureStatusLike | null> } | null | undefined>;
};

const isSignatureConfirmedFromHistory = async (
  wallet: WalletManager,
  signature: string,
): Promise<boolean> => {
  const connection = wallet.getConnection() as unknown as SignatureStatusConnectionLike;
  const getSignatureStatuses = connection.getSignatureStatuses?.bind(connection);

  if (typeof getSignatureStatuses !== "function") {
    return false;
  }

  const statusResult = await getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = statusResult?.value?.[0];

  if (!status) {
    return false;
  }

  if (status.err) {
    const error = new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    const errorWithCause = error as ErrorWithCause;
    errorWithCause.cause = status.err;
    throw errorWithCause;
  }

  if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
    return true;
  }

  if (typeof status.confirmations === "number" && status.confirmations > 0) {
    return true;
  }

  return false;
};

export const confirmTransactionWithRecovery = async (
  options: ConfirmTransactionWithRecoveryOptions,
): Promise<string> => {
  const {
    wallet,
    initialSignature,
    operationLabel,
    resubmit,
    probes = [],
    retryDelays = getConfirmationRetryDelays(),
    logger,
  } = options;

  const logDebug = (...args: unknown[]) => {
    if (typeof logger === "function") {
      logger(...args);
    }
  };

  let currentSignature = initialSignature;

  try {
    await wallet.confirmTransaction(currentSignature);
    logDebug(`✅ ${operationLabel} transaction confirmed: ${currentSignature}`);
    return currentSignature;
  } catch (confirmError: any) {
    console.warn(
      `⚠️ ${operationLabel} confirmation failed: ${confirmError?.message ?? confirmError}`,
    );

    const normalizedMessage = confirmError?.message?.toLowerCase?.() ?? "";
    const isTimeout =
      normalizedMessage.includes("timeout") ||
      normalizedMessage.includes("timed out") ||
      normalizedMessage.includes("not confirmed");
    const isExpiration =
      normalizedMessage.includes("expired before confirmation") ||
      normalizedMessage.includes("last valid block height");

    let lastRecoveryError: Error | undefined;

    if ((isTimeout || isExpiration) && resubmit) {
      for (let attempt = 0; attempt < TRANSACTION_RESUBMIT_ATTEMPTS; attempt++) {
        const attemptLabel = `${attempt + 1}/${TRANSACTION_RESUBMIT_ATTEMPTS}`;
        try {
          logDebug(
            `🔄 ${operationLabel} resubmission attempt ${attemptLabel} after failure for ${currentSignature}`,
          );
          const resubmittedSignature = await resubmit(attempt, currentSignature);

          if (!resubmittedSignature || typeof resubmittedSignature !== "string") {
            throw new Error("Resubmission callback did not return a transaction signature");
          }

          currentSignature = resubmittedSignature;
          logDebug(
            `✅ ${operationLabel} transaction resubmitted successfully ${attemptLabel}, obtained signature: ${currentSignature}`,
          );
          return currentSignature;
        } catch (resubmitError) {
          const normalizedError =
            resubmitError instanceof Error ? resubmitError : new Error(String(resubmitError));
          const latestSignature = hasLastSignature(normalizedError)
            ? normalizedError.lastSignature
            : undefined;
          if (latestSignature) {
            currentSignature = latestSignature;
          }

          lastRecoveryError = normalizedError;
          console.error(
            `❌ ${operationLabel} resubmission ${attemptLabel} failed`,
            normalizedError,
          );
        }
      }
    }

    if (isTimeout || isExpiration) {
      const retryPlan = retryDelays.length > 0 ? retryDelays : [];
      const recoveryErrors: Error[] = lastRecoveryError ? [lastRecoveryError] : [];

      for (let attempt = 0; attempt < retryPlan.length; attempt++) {
        const delay = retryPlan[attempt] ?? 0;
        const attemptLabel = `${attempt + 1}/${retryPlan.length}`;
        logDebug(`🔄 ${operationLabel} confirmation retry ${attemptLabel} after ${delay}ms`);
        await sleep(delay);

        if (probes.length > 0) {
          for (const probe of probes) {
            try {
              const ok = await probe.check();
              if (ok) {
                logDebug(
                  `✅ ${operationLabel} transaction confirmed via probe "${probe.label}" on retry ${attemptLabel}`,
                );
                return currentSignature;
              }
            } catch (probeError) {
              const normalizedProbeError =
                probeError instanceof Error ? probeError : new Error(String(probeError));
              console.error(
                `❌ Probe "${probe.label}" failed during ${operationLabel} retry ${attemptLabel}`,
                normalizedProbeError,
              );
              throw normalizedProbeError;
            }
          }
        }

        try {
          const signatureConfirmed = await isSignatureConfirmedFromHistory(
            wallet,
            currentSignature,
          );
          if (signatureConfirmed) {
            logDebug(
              `✅ ${operationLabel} transaction confirmed via signature status on retry ${attemptLabel}: ${currentSignature}`,
            );
            return currentSignature;
          }

          const statusError = new Error(
            `Transaction ${currentSignature} still pending after retry ${attempt + 1}`,
          );
          recoveryErrors.push(statusError);
          lastRecoveryError = statusError;
        } catch (statusProbeError) {
          const normalizedError =
            statusProbeError instanceof Error
              ? statusProbeError
              : new Error(String(statusProbeError));
          recoveryErrors.push(normalizedError);
          console.error(
            `❌ Failed to verify transaction status during ${operationLabel} retry ${attemptLabel}`,
            normalizedError,
          );
          throw normalizedError;
        }
      }

      const timeoutError: TimeoutErrorWithRecovery =
        confirmError instanceof Error ? confirmError : new Error(String(confirmError));
      if (recoveryErrors.length > 0) {
        timeoutError.recoveryErrors = recoveryErrors;
      }

      const preferredCause = lastRecoveryError;
      if (preferredCause && timeoutError.cause === undefined) {
        timeoutError.cause = preferredCause;
      }

      console.warn(
        `⚠️ ${operationLabel} confirmation timed out after ${retryPlan.length} retries for ${currentSignature}`,
      );
      throw timeoutError;
    }

    throw confirmError;
  }
};
