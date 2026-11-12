/** Pure search, filter and sort for the DataTable, so it can be tested without a DOM. */

export type CellValue = string | number;

export interface TableRow {
  id: string;
  /** The plain value of each column, used to search, filter and sort. */
  values: Record<string, CellValue>;
}

export interface SortState {
  key: string;
  direction: "ascending" | "descending";
}

export interface TableQuery {
  search: string;
  /** Column key to the one value kept; a missing key keeps every row. */
  filters: Record<string, string>;
  sort: SortState | null;
}

const text = (v: CellValue | undefined) => String(v ?? "").toLowerCase();

/** Rows matching the search words (all of them, anywhere in any column) and filters, sorted. */
export function queryRows<R extends TableRow>(
  rows: R[],
  q: TableQuery,
  searchKeys: string[],
): R[] {
  const words = q.search.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = rows.filter((row) => {
    for (const [key, want] of Object.entries(q.filters))
      if (want && String(row.values[key] ?? "") !== want) return false;
    if (!words.length) return true;
    const hay = searchKeys.map((k) => text(row.values[k])).join(" ");
    return words.every((w) => hay.includes(w));
  });
  const sort = q.sort;
  if (!sort) return kept;
  const sign = sort.direction === "ascending" ? 1 : -1;
  // Stable: rows that compare equal keep their original order.
  return kept
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = a.row.values[sort.key];
      const y = b.row.values[sort.key];
      const c =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x ?? "").localeCompare(String(y ?? ""), "en", {
              numeric: true,
              sensitivity: "base",
            });
      return c ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}

/** Click on a column head: ascending, then descending, then back to the given order. */
export function nextSort(
  current: SortState | null,
  key: string,
): SortState | null {
  if (current?.key !== key) return { key, direction: "ascending" };
  return current.direction === "ascending"
    ? { key, direction: "descending" }
    : null;
}

/** The distinct values of a column, in first-seen order, for a filter's options. */
export function distinctValues(rows: TableRow[], key: string): string[] {
  return [
    ...new Set(rows.map((r) => String(r.values[key] ?? "")).filter(Boolean)),
  ];
}

/** Arrow-key target for a tab list: wraps, Home and End jump. Null for other keys. */
export function nextTabIndex(key: string, current: number, count: number) {
  if (count < 1) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
