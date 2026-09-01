import { isQuoteMint } from "./positions";

export type HoldMarkStore = {
  get(wallet: string, mint: string): number | undefined;
  set(wallet: string, mint: string, priceUsd: number): void;
  listMints(wallet: string): string[];
  delete(wallet: string, mint: string): void;
};

export function createMemoryHoldMarkStore(): HoldMarkStore {
  const rows = new Map<string, number>();
  const keyFor = (wallet: string, mint: string) => `${wallet}\0${mint}`;
  return {
    get(wallet, mint) {
      return rows.get(keyFor(wallet, mint));
    },
    set(wallet, mint, priceUsd) {
      const key = keyFor(wallet, mint);
      if (!rows.has(key)) {
        rows.set(key, priceUsd);
      }
    },
    listMints(wallet) {
      const prefix = `${wallet}\0`;
      const mints: string[] = [];
      for (const key of rows.keys()) {
        if (key.startsWith(prefix)) {
          mints.push(key.slice(prefix.length));
        }
      }
      return mints;
    },
    delete(wallet, mint) {
      rows.delete(keyFor(wallet, mint));
    },
  };
}

export function applyHoldMarks(args: {
  walletAddress: string;
  marks: Array<{ mint: string; priceUsd: number }>;
  store: HoldMarkStore;
}): Map<string, number> {
  const percents = new Map<string, number>();
  const wallet = args.walletAddress.trim();
  if (!wallet) {
    return percents;
  }

  for (const mark of args.marks) {
    const mint = mark.mint?.trim();
    const priceUsd = mark.priceUsd;
    if (!mint || isQuoteMint(mint) || !(priceUsd > 0) || !Number.isFinite(priceUsd)) {
      continue;
    }

    const saved = args.store.get(wallet, mint);
    if (saved == null || !(saved > 0) || !Number.isFinite(saved)) {
      args.store.set(wallet, mint, priceUsd);
      continue;
    }

    percents.set(mint, (priceUsd - saved) / saved);
  }

  return percents;
}

export type PruneHoldMarksOptions = {
  /**
   * Full owner scan succeeded. Missing from `heldMints` then means the token left.
   * Empty or ATA-only lists must not pass this.
   */
  complete?: boolean;
  /**
   * Mints this fetch actually looked at. A mark is dropped only if we scanned it
   * and it is not in `heldMints`. Absence from an unscanned list is not a sale.
   */
  scannedMints?: Iterable<string>;
};

function collectMints(mints: Iterable<string> | undefined): Set<string> {
  const collected = new Set<string>();
  if (!mints) {
    return collected;
  }
  for (const mint of mints) {
    const trimmed = mint?.trim();
    if (trimmed) {
      collected.add(trimmed);
    }
  }
  return collected;
}

export function pruneHoldMarks(
  walletAddress: string,
  heldMints: Iterable<string>,
  store: HoldMarkStore,
  options?: PruneHoldMarksOptions,
): void {
  const wallet = walletAddress.trim();
  if (!wallet) {
    return;
  }

  const held = collectMints(heldMints);
  const scanned = collectMints(options?.scannedMints);
  const dropUnseen = options?.complete === true;
  if (!dropUnseen && scanned.size === 0) {
    return;
  }

  for (const mint of store.listMints(wallet)) {
    const confirmedGone = dropUnseen ? !held.has(mint) : scanned.has(mint) && !held.has(mint);
    if (confirmedGone) {
      store.delete(wallet, mint);
    }
  }
}
