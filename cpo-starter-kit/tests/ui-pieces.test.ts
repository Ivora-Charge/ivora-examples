import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { crumbsFor } from "@/lib/breadcrumbs";
import {
  distinctValues,
  nextSort,
  nextTabIndex,
  queryRows,
  type TableRow,
} from "@/lib/data-table";
import { PHASE_CHIPS, STATION_CHIPS, connectorChip } from "@/lib/status-chips";
import { DataTable } from "@/app/ui/data-table";
import { EmptyState } from "@/app/ui/empty-state";
import { Field, SavedState } from "@/app/ui/field";
import { PageHeader } from "@/app/ui/page-header";
import { Chip } from "@/app/ui/status-chip";
import { SummaryStrip } from "@/app/ui/summary-strip";
import { Tabs } from "@/app/ui/tabs";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);

const SECTIONS = [
  { href: "/chargers", label: "Chargers" },
  { href: "/live", label: "Live" },
  { href: "/pricing", label: "Pricing" },
];

describe("breadcrumbs", () => {
  it("shows none on a top-level page", () => {
    expect(crumbsFor("/chargers", SECTIONS)).toEqual([]);
    expect(crumbsFor("/", SECTIONS)).toEqual([]);
  });
  it("links the levels above and leaves the current page plain", () => {
    expect(crumbsFor("/pricing/new", SECTIONS)).toEqual([
      { label: "Pricing", href: "/pricing" },
      { label: "New" },
    ]);
    expect(crumbsFor("/chargers/st%201/stickers", SECTIONS)).toEqual([
      { label: "Chargers", href: "/chargers" },
      { label: "st 1", href: "/chargers/st%201" },
      { label: "Stickers" },
    ]);
  });
  it("uses a page's own name for its level instead of the raw key", () => {
    expect(
      crumbsFor("/chargers/st%201/stickers", SECTIONS, {
        "/chargers/st 1": "Harbour 1",
      }),
    ).toEqual([
      { label: "Chargers", href: "/chargers" },
      { label: "Harbour 1", href: "/chargers/st%201" },
      { label: "Stickers" },
    ]);
  });
  it("skips path levels that have no page", () => {
    expect(crumbsFor("/live/stations/9102", SECTIONS)).toEqual([
      { label: "Live", href: "/live" },
      { label: "9102" },
    ]);
  });
  it("shows none for an unknown section", () => {
    expect(crumbsFor("/nope/x", SECTIONS)).toEqual([]);
  });
});

const ROWS: TableRow[] = [
  { id: "a", values: { name: "Harbour 2", state: "Online", kwh: 12 } },
  { id: "b", values: { name: "harbour 10", state: "Offline", kwh: 100 } },
  { id: "c", values: { name: "Depot", state: "Online", kwh: 9 } },
];
const ids = (rows: TableRow[]) => rows.map((r) => r.id);
const KEYS = ["name", "state"];

describe("data table logic", () => {
  const none = { search: "", filters: {}, sort: null };
  it("searches every word, case-insensitively, across the searchable columns", () => {
    expect(ids(queryRows(ROWS, { ...none, search: "HARBOUR" }, KEYS))).toEqual([
      "a",
      "b",
    ]);
    expect(
      ids(queryRows(ROWS, { ...none, search: "harbour offline" }, KEYS)),
    ).toEqual(["b"]);
    expect(ids(queryRows(ROWS, { ...none, search: "zzz" }, KEYS))).toEqual([]);
  });
  it("filters by one exact value and ignores an empty filter", () => {
    expect(
      ids(queryRows(ROWS, { ...none, filters: { state: "Online" } }, KEYS)),
    ).toEqual(["a", "c"]);
    expect(
      ids(queryRows(ROWS, { ...none, filters: { state: "" } }, KEYS)),
    ).toEqual(["a", "b", "c"]);
  });
  it("sorts numbers as numbers and names naturally, both ways", () => {
    const asc = (key: string) =>
      ids(
        queryRows(
          ROWS,
          { ...none, sort: { key, direction: "ascending" } },
          KEYS,
        ),
      );
    expect(asc("kwh")).toEqual(["c", "a", "b"]);
    expect(asc("name")).toEqual(["c", "a", "b"]); // Depot, Harbour 2, harbour 10
    expect(
      ids(
        queryRows(
          ROWS,
          { ...none, sort: { key: "kwh", direction: "descending" } },
          KEYS,
        ),
      ),
    ).toEqual(["b", "a", "c"]);
  });
  it("cycles a column head: ascending, descending, off", () => {
    const one = nextSort(null, "name");
    expect(one).toEqual({ key: "name", direction: "ascending" });
    const two = nextSort(one, "name");
    expect(two).toEqual({ key: "name", direction: "descending" });
    expect(nextSort(two, "name")).toBeNull();
    expect(nextSort(two, "kwh")).toEqual({
      key: "kwh",
      direction: "ascending",
    });
  });
  it("lists a column's distinct values in order", () => {
    expect(distinctValues(ROWS, "state")).toEqual(["Online", "Offline"]);
  });
  it("moves between tabs with the arrow keys, wrapping, and Home and End", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
    expect(nextTabIndex("a", 0, 3)).toBeNull();
  });
});

describe("status chips", () => {
  it("always carry a word, and one tone per state", () => {
    expect(html(h(Chip, { spec: STATION_CHIPS.online }))).toBe(
      '<span class="pill ok">Online</span>',
    );
    expect(connectorChip("Available").tone).toBe("ok");
    expect(connectorChip("Charging").tone).toBe("busy");
    expect(connectorChip("Faulted").tone).toBe("warn");
    expect(connectorChip("Unavailable").tone).toBe("off");
    for (const spec of [
      ...Object.values(STATION_CHIPS),
      ...Object.values(PHASE_CHIPS),
    ])
      expect(spec.label.length).toBeGreaterThan(2);
  });
});

describe("page pieces", () => {
  it("page header has one h1 and an optional action", () => {
    const out = html(
      h(PageHeader, {
        title: "Chargers",
        description: "Your chargers",
        action: h("a", { href: "/chargers/new", className: "button" }, "Add"),
      }),
    );
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain("Add</a>");
    expect(html(h(PageHeader, { title: "X" }))).not.toContain(
      "page-header-action",
    );
  });

  it("field ties help and error to the control", () => {
    const out = html(
      h(Field, {
        id: "kwh",
        label: "Price per kWh",
        help: "Excl. tax",
        error: "Enter a number",
        children: (c) => h("input", c),
      }),
    );
    expect(out).toContain('for="kwh"');
    expect(out).toContain('aria-describedby="kwh-help kwh-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain("Enter a number");
    const clean = html(
      h(Field, {
        id: "n",
        label: "Name",
        children: (c) => h("input", c),
      }),
    );
    expect(clean).not.toContain("aria-describedby");
    expect(clean).not.toContain("aria-invalid");
  });

  it("saved state keeps its live region and shows the word only when saved", () => {
    expect(html(h(SavedState, {}))).toBe(
      '<span class="saved" role="status"></span>',
    );
    expect(html(h(SavedState, { saved: true }))).toContain("Saved");
  });

  it("empty state offers a next step; an error one is an alert", () => {
    const empty = html(
      h(EmptyState, {
        title: "No chargers",
        action: h("a", { href: "/x" }, "Add one"),
        children: "Add your first.",
      }),
    );
    expect(empty).toContain("Add one");
    expect(empty).not.toContain('role="alert"');
    expect(
      html(
        h(EmptyState, {
          title: "Failed",
          tone: "error",
          children: "Nothing changed.",
        }),
      ),
    ).toContain('role="alert"');
  });

  it("summary strip lists label and value, linking where asked", () => {
    const out = html(
      h(SummaryStrip, {
        label: "Charger summary",
        items: [
          { label: "Online", value: 3, unit: "of 4" },
          { label: "Faults", value: 1, href: "/live" },
        ],
      }),
    );
    expect(out).toContain("<dt>Online</dt>");
    expect(out).toContain('href="/live"');
    // The link names itself with the label, not the bare figure.
    expect(out).toContain('<span class="visually-hidden">Faults: </span>1</a>');
  });

  it("summary strip marks the figure in force as current", () => {
    const out = html(
      h(SummaryStrip, {
        label: "Live summary",
        items: [
          { label: "All", value: 4, href: "/live" },
          {
            label: "Faulted",
            value: 1,
            href: "/live?status=faulted",
            active: true,
          },
        ],
      }),
    );
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("tabs render a tablist, with only the first panel visible", () => {
    const out = html(
      h(Tabs, {
        label: "Charger",
        tabs: [
          { id: "a", label: "Overview", panel: "A body" },
          { id: "b", label: "History", panel: "B body" },
        ],
      }),
    );
    expect(out).toContain('role="tablist"');
    expect(out.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(out.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(out.match(/ hidden=""/g)).toHaveLength(1);
  });

  it("data table renders headers, stacked-card labels and sortable heads", () => {
    const out = html(
      h(DataTable, {
        caption: "Chargers",
        columns: [
          { key: "name", label: "Name" },
          { key: "state", label: "Status", filter: true },
          { key: "kwh", label: "kWh", numeric: true },
        ],
        rows: ROWS,
      }),
    );
    expect(out).toContain('scope="col"');
    expect(out).toContain('data-label="Status"');
    expect(out).toContain("<button");
    expect(out).toContain("All status");
    expect(out).toContain("3 rows");
  });

  it("data table with no rows shows the empty state and its next step", () => {
    const out = html(
      h(DataTable, {
        caption: "Chargers",
        columns: [{ key: "name", label: "Name" }],
        rows: [],
        empty: {
          text: "Add your first charger.",
          action: h("a", { href: "/chargers" }, "Add"),
        },
      }),
    );
    expect(out).toContain("Add your first charger.");
    expect(out).not.toContain("<table");
  });
});
