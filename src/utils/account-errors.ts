/**
 * Returns true when an account lookup proved that the account is absent.
 *
 * RPC and decoder failures must not be treated as an absent game because doing
 * so can incorrectly cancel a game or erase its active message state.
 */
export function isMissingAccountError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "ACCOUNT_NOT_FOUND" || code === "AccountNotFound") return true;

  const message = "message" in error ? (error as { message?: unknown }).message : undefined;
  return (
    typeof message === "string" &&
    /Account(?:\s+[^\n]+)?\s+(?:does not exist|not found)/i.test(message)
  );
}
