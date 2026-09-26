/**
 * Maps items with at most `limit` mapper calls in flight, preserving input order.
 */
export const mapWithConcurrency = async <TItem, TResult>(
  items: TItem[],
  limit: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> => {
  if (items.length === 0) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 0;
  const workerCount = Math.max(1, Math.min(items.length, safeLimit || 1));
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
};
