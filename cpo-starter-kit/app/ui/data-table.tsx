"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import {
  distinctValues,
  nextSort,
  queryRows,
  type CellValue,
  type SortState,
  type TableRow,
} from "@/lib/data-table";
import { EmptyState } from "./empty-state";

export interface DataTableColumn {
  key: string;
  label: string;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
  /** Cannot be sorted. */
  fixed?: boolean;
  /** Offered as a filter, with the distinct values of the column as options. */
  filter?: boolean;
  /** Left out of the search. */
  noSearch?: boolean;
}

export interface DataTableRow extends TableRow {
  /** What to show, per column key; falls back to the plain value. */
  cells?: Record<string, ReactNode>;
}

/**
 * Search, filter, sort, row density and a sticky header over rows the page already
 * has. On a phone each row stacks into a card, the column label above its value.
 * `caption` names the table for screen readers.
 */
export function DataTable({
  caption,
  columns,
  rows,
  emptyTitle = "Nothing here yet",
  empty,
}: {
  caption: string;
  columns: DataTableColumn[];
  rows: DataTableRow[];
  emptyTitle?: string;
  /** Shown when there are no rows at all: what to do next. */
  empty?: { text: ReactNode; action?: ReactNode };
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | null>(null);
  const [compact, setCompact] = useState(false);

  const searchKeys = columns.filter((c) => !c.noSearch).map((c) => c.key);
  const filterCols = columns.filter((c) => c.filter);
  const options = useMemo(
    () =>
      Object.fromEntries(
        filterCols.map((c) => [c.key, distinctValues(rows, c.key)]),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, columns],
  );
  const shown = useMemo(
    () => queryRows(rows, { search, filters, sort }, searchKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, search, filters, sort, columns],
  );
  const narrowed = search.trim() !== "" || Object.values(filters).some(Boolean);

  if (!rows.length)
    return (
      <div className="card">
        <EmptyState title={emptyTitle} action={empty?.action}>
          {empty?.text ?? "Nothing to show yet."}
        </EmptyState>
      </div>
    );

  const show = (row: DataTableRow, key: string): ReactNode =>
    row.cells?.[key] ?? (row.values[key] as CellValue | undefined) ?? "";

  return (
    <div className="card table-card">
      <div className="table-toolbar">
        <div className="field grow">
          <label htmlFor={`${id}-search`} className="visually-hidden">
            Search {caption}
          </label>
          <input
            id={`${id}-search`}
            type="search"
            placeholder="Search"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {filterCols.map((c) => (
          <div className="field" key={c.key}>
            <label htmlFor={`${id}-f-${c.key}`} className="visually-hidden">
              Filter by {c.label.toLowerCase()}
            </label>
            <select
              id={`${id}-f-${c.key}`}
              value={filters[c.key] ?? ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, [c.key]: e.target.value }))
              }
            >
              <option value="">All {c.label.toLowerCase()}</option>
              {options[c.key].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        ))}
        <button
          type="button"
          className="button secondary"
          aria-pressed={compact}
          onClick={() => setCompact((c) => !c)}
        >
          Compact rows
        </button>
      </div>
      <div
        className="table-scroll-area"
        tabIndex={0}
        role="region"
        aria-label={caption}
      >
        <table className={compact ? "grid-table compact" : "grid-table"}>
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={c.numeric ? "num" : undefined}
                  aria-sort={sort?.key === c.key ? sort.direction : undefined}
                >
                  {c.fixed ? (
                    c.label
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSort((s) => nextSort(s, c.key))}
                    >
                      {c.label}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-label={c.label}
                    className={c.numeric ? "num" : undefined}
                  >
                    {show(row, c.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <EmptyState
            title="No matches"
            action={
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setSearch("");
                  setFilters({});
                }}
              >
                Clear search and filters
              </button>
            }
          >
            Nothing matches your search and filters.
          </EmptyState>
        )}
      </div>
      <p className="table-count muted" role="status">
        {narrowed
          ? `Showing ${shown.length} of ${rows.length}`
          : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`}
      </p>
    </div>
  );
}
