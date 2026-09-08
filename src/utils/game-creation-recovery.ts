/** A missing signature/account is not proof of non-execution: games can be closed.
 * Prove absence by walking the complete finalized parent chain back to the exact
 * recent blockhash, checking every block's signatures. A second RPC must agree
 * on the finalized anchor. Incomplete/pruned/disagreeing reads stay unknown.
 */
export type RecoveryRpc = (method: string, params: unknown[]) => Promise<any>;
export type ExpiredCreation = {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  gameAddress: string;
};

export async function proveExpiredCreationAbsent(
  input: ExpiredCreation,
  primary: RecoveryRpc,
  witness: RecoveryRpc,
): Promise<boolean> {
  if (!Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight < 0) {
    return false;
  }
  const genesis = await Promise.all([primary("getGenesisHash", []), witness("getGenesisHash", [])]);
  if (!genesis[0] || genesis[0] !== genesis[1]) return false;
  let slot = await primary("getSlot", [{ commitment: "finalized" }]);
  const config = {
    commitment: "finalized",
    transactionDetails: "signatures",
    rewards: false,
    maxSupportedTransactionVersion: 0,
  };
  let block = await primary("getBlock", [slot, config]);
  if (
    !block ||
    !Number.isSafeInteger(block.blockHeight) ||
    block.blockHeight <= input.lastValidBlockHeight
  )
    return false;
  // After a restart, jump close to expiry before walking the lifetime. We
  // need not scan blocks produced after expiry; they cannot include this tx.
  const distance = block.blockHeight - input.lastValidBlockHeight;
  if (distance > 64) {
    const slots = await primary("getBlocks", [
      Math.max(0, slot - Math.min(50_000, (distance + 256) * 2)),
      slot,
      { commitment: "finalized" },
    ]);
    if (
      !Array.isArray(slots) ||
      !slots.length ||
      slots.some(
        (value: unknown, index: number) =>
          !Number.isSafeInteger(value) ||
          Number(value) > slot ||
          (index > 0 && Number(value) <= slots[index - 1]),
      )
    )
      return false;
    let low = 0;
    let high = slots.length - 1;
    let candidate: { slot: number; block: any } | undefined;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const probe = await primary("getBlock", [slots[mid], config]);
      if (!probe || !Number.isSafeInteger(probe.blockHeight)) return false;
      if (probe.blockHeight > input.lastValidBlockHeight) {
        candidate = { slot: slots[mid], block: probe };
        high = mid - 1;
      } else low = mid + 1;
    }
    if (!candidate) return false;
    slot = candidate.slot;
    block = candidate.block;
  }
  const anchor = await witness("getBlock", [slot, config]);
  if (!anchor || anchor.blockhash !== block.blockhash || anchor.blockHeight !== block.blockHeight)
    return false;
  for (const rpc of [primary, witness]) {
    const validity = await rpc("isBlockhashValid", [
      input.blockhash,
      { commitment: "finalized", minContextSlot: slot },
    ]);
    if (
      validity?.value !== false ||
      !Number.isSafeInteger(validity.context?.slot) ||
      validity.context.slot < slot
    )
      return false;
    const status = await rpc("getSignatureStatuses", [
      [input.signature],
      { searchTransactionHistory: true },
    ]);
    const account = await rpc("getAccountInfo", [
      input.gameAddress,
      { commitment: "finalized", minContextSlot: slot, encoding: "base64" },
    ]);
    if (
      !Array.isArray(status?.value) ||
      status.value.length !== 1 ||
      status.value[0] !== null ||
      account?.value !== null ||
      !Number.isSafeInteger(account.context?.slot) ||
      account.context.slot < slot
    )
      return false;
  }
  // Bounded work for recent incidents. Old/pruned history never becomes an
  // automatic authorization to charge again, even after many retries.
  let currentSlot = slot;
  for (let count = 0; count < 256; count++) {
    if (
      !Array.isArray(block.signatures) ||
      block.signatures.some((s: unknown) => typeof s !== "string")
    )
      return false;
    if (block.signatures.includes(input.signature)) return false;
    if (block.blockhash === input.blockhash) return true;
    if (!Number.isSafeInteger(block.parentSlot) || block.parentSlot >= currentSlot) return false;
    const parent = await primary("getBlock", [block.parentSlot, config]);
    if (
      !parent ||
      parent.blockhash !== block.previousBlockhash ||
      parent.blockHeight !== block.blockHeight - 1
    )
      return false;
    currentSlot = block.parentSlot;
    block = parent;
  }
  return false;
}

/** No overlapping sends; stop scheduling immediately when confirmation finishes. */
export async function withCreationRebroadcast<T>(
  confirm: () => Promise<T>,
  rebroadcast: (signal: AbortSignal) => Promise<void>,
  intervalMs = 3_000,
): Promise<T> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const tick = async () => {
    try {
      await rebroadcast(controller.signal);
    } catch {
      /* Durable recovery owns ambiguous sends. */
    }
    if (!stopped)
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
  };
  timer = setTimeout(() => {
    void tick();
  }, intervalMs);
  try {
    return await confirm();
  } finally {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  }
}

/** Replacement lifetimes get their own fast retry window, including after restart. */
export function getCreationRecoveryDelay(
  record: {
    state: string;
    created_at: number;
    transaction_prepared_at?: number | null;
    attempts: number;
  },
  now = Date.now(),
): number {
  if (
    record.state === "failed" ||
    now - (record.transaction_prepared_at ?? record.created_at) < 180_000
  )
    return 3_000;
  return Math.min(900_000, 30_000 * 2 ** Math.min(record.attempts, 5));
}
