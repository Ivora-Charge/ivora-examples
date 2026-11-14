import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY } from "@/lib/action-state";
import { createDemoClient, memoryDemoFleet } from "@/lib/server/ivora/demo";
import {
  createDemoPricingStore,
  memoryDemoPricing,
} from "@/lib/server/pricing/demo";
import {
  currentVersion,
  editorValues,
  type PricingDeps,
} from "@/lib/server/pricing/service";
import type { TariffDefinition } from "@/lib/server/pricing/types";
import type { Staff } from "@/lib/server/team/types";

// Saving from the restyled tariff editor stores exactly the definition the editor
// was filled from: the fields the form renders (names, values, defaults, checked
// boxes) go through the real save action and pricing service into the demo store.
// The editor changed presentation only, so the stored definition must not change.

const OPERATOR = "10000000-0000-4000-8000-0000000000aa";
const owner: Staff = {
  userId: "00000000-0000-4000-8000-000000000005",
  email: "owner@example.com",
  role: "owner",
  operatorId: OPERATOR,
  operatorName: "Sample Operator",
  demo: false,
};

let deps: PricingDeps;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("redirect"), { url });
  },
}));
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<object>()),
  requireRole: async () => owner,
}));
vi.mock("@/lib/server/pricing", async (orig) => ({
  ...(await orig<object>()),
  getPricing: () => deps,
}));

const { TariffEditor } = await import("@/app/(staff)/pricing/forms");
const { saveTariffAction } = await import("@/app/(staff)/pricing/actions");

/** The field names the editor submitted before the restyle. */
const FIELDS_BEFORE = new Set([
  "name",
  "kind",
  "timeZone",
  "energy",
  "sessionFee",
  "idleFee",
  "idleGrace",
  "driverText",
  "sim.date",
  "sim.start",
  "sim.end",
  "sim.energyKwh",
  "sim.idleMinutes",
]);

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : undefined;
};
const has = (tag: string, name: string) =>
  new RegExp(`\\s${name}(=|\\s|/|>)`).test(tag);

/**
 * The form data a browser builds from the rendered editor: named inputs (checkboxes
 * and radios only when checked), each select's selected option and each textarea.
 * Buttons are left out: the submitter is added by the caller.
 */
function formDataOf(html: string): FormData {
  const data = new FormData();
  const re =
    /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/g;
  for (const [el] of html.matchAll(re)) {
    const open = el.match(/^<[^>]*>/)![0];
    const name = attr(open, "name");
    if (!name || has(open, "disabled")) continue;
    if (el.startsWith("<input")) {
      const type = attr(open, "type") ?? "text";
      if ((type === "checkbox" || type === "radio") && !has(open, "checked"))
        continue;
      data.append(
        name,
        attr(open, "value") ?? (type === "checkbox" ? "on" : ""),
      );
    } else if (el.startsWith("<select")) {
      const options = [...el.matchAll(/<option\b[^>]*>/g)].map(([o]) => o);
      const chosen = options.find((o) => has(o, "selected")) ?? options[0];
      if (chosen) data.append(name, attr(chosen, "value") ?? "");
    } else {
      data.append(name, unescape(el.replace(/^<[^>]*>|<\/textarea>$/g, "")));
    }
  }
  return data;
}

const editorHtml = (name: string, def: TariffDefinition) =>
  renderToStaticMarkup(
    h(TariffEditor, {
      tariffId: null,
      initial: editorValues(name, def, { currency: "USD", timeZone: "UTC" }),
      currency: "USD",
      timeZones: ["UTC", "America/New_York"],
      simulation: {
        date: "2026-10-20",
        start: "18:00",
        end: "20:30",
        energyKwh: "30",
        idleMinutes: "15",
      },
    }),
  );

function editorForm(name: string, def: TariffDefinition): FormData {
  const data = formDataOf(editorHtml(name, def));
  data.append("intent", "save");
  return data;
}

/** Saves the form with the real server action; returns the stored definition. */
async function save(data: FormData): Promise<TariffDefinition> {
  const outcome = await saveTariffAction(EMPTY, data).catch((e: unknown) => e);
  // A new tariff redirects to its page once saved.
  expect(outcome).toMatchObject({ url: expect.stringMatching(/^\/pricing\//) });
  const [tariff] = (await deps.store.load(OPERATOR)).tariffs;
  return currentVersion(tariff)!.definition!;
}

const base: Omit<TariffDefinition, "energyMinorPerKwh"> = {
  kind: "paid",
  currency: "USD",
  timeZone: "UTC",
  sessionFeeMinor: 0,
  idleMinorPerMinute: 0,
  idleGraceMinutes: 0,
  periods: [],
  driverText: null,
};

const CASES: [string, TariffDefinition][] = [
  ["per kWh", { ...base, energyMinorPerKwh: 35 }],
  [
    "per kWh with a session fee, idle fee and free minutes",
    {
      ...base,
      timeZone: "America/New_York",
      energyMinorPerKwh: 42,
      sessionFeeMinor: 100,
      idleMinorPerMinute: 20,
      idleGraceMinutes: 10,
      driverText: "Pay by card at the charger.",
    },
  ],
  [
    "time of use",
    {
      ...base,
      energyMinorPerKwh: 30,
      periods: [
        {
          days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
          start: "16:00",
          end: "21:00",
          energyMinorPerKwh: 45,
        },
        {
          days: ["SATURDAY", "SUNDAY"],
          start: "22:00",
          end: "06:00",
          energyMinorPerKwh: 25,
        },
      ],
    },
  ],
  ["free", { ...base, kind: "free", energyMinorPerKwh: 0 }],
];

describe("saving from the tariff editor", () => {
  beforeEach(() => {
    deps = {
      store: createDemoPricingStore(
        memoryDemoPricing({ v: 1, tariffs: [], stations: [] }),
      ),
      ivora: createDemoClient(memoryDemoFleet()),
      company: {
        load: async () => ({ currency: "USD", timeZone: "UTC" }) as never,
      },
    };
  });

  it.each(CASES)("stores the same %s definition", async (_, def) => {
    const data = editorForm("Standard", def);
    expect(await save(data)).toEqual(def);
  });

  it("submits the same fields as before, and no others", () => {
    const [, tou] = CASES[2];
    const names = new Set(editorForm("Standard", tou).keys());
    names.delete("intent");
    const periods = [...names].filter((n) => n.startsWith("periods."));
    for (const n of periods) names.delete(n);
    expect(names).toEqual(FIELDS_BEFORE);
    expect(new Set(periods)).toEqual(
      new Set(
        [0, 1].flatMap((i) =>
          ["start", "end", "price", "days"].map((f) => `periods.${i}.${f}`),
        ),
      ),
    );
    // Free leaves out the price fields, as before.
    const free = new Set(editorForm("Staff", CASES[3][1]).keys());
    for (const n of ["energy", "sessionFee", "idleFee", "idleGrace"])
      expect(free.has(n)).toBe(false);
    expect(free.has("kind")).toBe(true);
  });

  it("holds the preview column with a short note until a preview is asked for", () => {
    const html = editorHtml("Standard", CASES[0][1]);
    expect(html).toContain('data-testid="preview-placeholder"');
    expect(html).toMatch(/press &quot;Preview price&quot;/);
  });
});
