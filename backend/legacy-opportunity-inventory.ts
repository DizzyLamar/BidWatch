export type LegacyInventoryPageOptions = { limit: number; offset: number };
export type LegacyInventoryList<T> = (options: LegacyInventoryPageOptions) => Promise<{ items: T[] }>;

export async function readPagedLegacyInventory<T>(
  list: LegacyInventoryList<T>,
  options: { maxRecords?: number; pageSize?: number } = {},
): Promise<{ items: T[]; complete: boolean }> {
  const maxRecords = Math.max(1, Math.min(Math.trunc(options.maxRecords ?? 5000), 5000));
  const pageSize = Math.max(1, Math.min(Math.trunc(options.pageSize ?? 500), 1000));
  const items: T[] = [];
  let offset = 0;
  let complete = false;

  while (items.length < maxRecords) {
    const limit = Math.min(pageSize, maxRecords - items.length);
    const page = await list({ limit, offset });
    items.push(...page.items.slice(0, limit));
    if (page.items.length < limit) {
      complete = true;
      break;
    }
    offset += page.items.length;
  }

  if (items.length === maxRecords) {
    // One bounded extra read distinguishes an exactly-full inventory from a
    // truncated one without relying on PostgREST's configured max_rows.
    const remainder = await list({ limit: 1, offset });
    complete = remainder.items.length === 0;
  }

  return { items, complete };
}
