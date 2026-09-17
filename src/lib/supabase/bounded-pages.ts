const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_PAGES = 50;

type SupabasePage<T, E> = {
  data: T[] | null;
  error: E | null;
};

export type BoundedPageResult<T, E> =
  | { complete: true; rows: T[] }
  | { complete: false; reason: "query"; error: E }
  | { complete: false; reason: "limit"; error: null };

/**
 * Reads a deterministically ordered PostgREST query past Supabase's default
 * response-row ceiling. The caller owns the query and must apply a stable,
 * unique final ordering before `.range()` is added by `fetchPage`.
 *
 * Partial data is never returned after an upstream error or when the safety
 * bound is reached, so callers cannot accidentally present a truncated
 * inventory as complete.
 */
export async function collectBoundedSupabasePages<T, E = unknown>(
  fetchPage: (from: number, to: number) => Promise<SupabasePage<T, E>>,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<BoundedPageResult<T, E>> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("Supabase page size must be a positive integer");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("Supabase max pages must be a positive integer");
  }

  const rows: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) {
      return { complete: false, reason: "query", error: result.error };
    }

    const pageRows = result.data ?? [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) {
      return { complete: true, rows };
    }
  }

  return { complete: false, reason: "limit", error: null };
}
