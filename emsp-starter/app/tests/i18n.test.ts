import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createI18n } from "../src/i18n/core";
import en from "../src/i18n/en.json";
import { MAX_EXCEPTIONS, upcomingExceptions } from "../src/lib/hours";
import { present } from "../src/lib/present";
import type {
  DisplayComponent,
  DisplayPrice,
  LocationSummary,
} from "../src/lib/types";

const root = join(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
const sources = files(join(root, "src")).map((f) => ({
  file: relative(root, f),
  code: readFileSync(f, "utf8"),
}));

describe("strings", () => {
  it("has every key the code asks for", () => {
    const keys = new Set(Object.keys(en));
    const missing: string[] = [];
    for (const { file, code } of sources) {
      for (const m of code.matchAll(/\bt\(\s*"([^"]+)"/g))
        if (!keys.has(m[1])) missing.push(`${file}: ${m[1]}`);
      for (const m of code.matchAll(/\btn\(\s*"([^"]+)"/g))
        if (!keys.has(`${m[1]}_other`)) missing.push(`${file}: ${m[1]}_other`);
    }
    expect(missing).toEqual([]);
  });

  it("keeps words out of the components: no literal text, labels or placeholders", () => {
    const offenders = sources
      .filter((s) => s.file.endsWith(".tsx"))
      .flatMap(({ file, code }) => {
        const found: string[] = [];
        // Text between tags, such as <Text>Find a charger</Text>.
        for (const m of code.matchAll(/>\s*([A-Za-z][^<>{}]{1,})\s*<\//g))
          found.push(`${file}: ${m[1]}`);
        // Literal accessibility labels and placeholders.
        for (const m of code.matchAll(
          /\b(aria-label|placeholder|label)="([^"]+)"/g,
        ))
          found.push(`${file}: ${m[1]}="${m[2]}"`);
        return found;
      });
    expect(offenders).toEqual([]);
  });

  it("fills placeholders and picks plural forms", () => {
    const i = createI18n("en-GB");
    expect(i.t("place.free", { free: 2, total: 3 })).toBe("2 of 3 free");
    expect(i.tn("results.places", 1)).toBe("1 place");
    expect(i.tn("results.places", 6)).toBe("6 places");
    expect(i.tn("results.places", 1234)).toBe("1,234 places");
  });

  it("falls back to English for a language without strings", () => {
    const i = createI18n("de-DE", {});
    expect(i.t("filters.openNow")).toBe("Open now");
  });
});

describe("formats by locale", () => {
  const plain = (s: string) => s.replace(/\s/g, " ");
  it("formats CAD, USD and a 3-decimal currency with the currency's own digits", () => {
    expect(createI18n("en-CA").money(3500, "CAD")).toBe("$0.35");
    expect(createI18n("en-US").money(3500, "CAD")).toBe("CA$0.35");
    expect(createI18n("fr-CA").minor(2500, "CAD").replace(/\s/g, " ")).toBe(
      "25,00 $",
    );
    expect(createI18n("en-US").minor(2500, "USD")).toBe("$25.00");
    expect(createI18n("en-US").minor(2500, "KWD").replace(/\s/g, " ")).toBe(
      "KWD 2.500",
    );
  });
  it("formats money from ten-thousandths, rounded to the currency's minor unit", () => {
    expect(createI18n("en-GB").money(7139, "EUR")).toBe("€0.71");
    expect(createI18n("en-GB").money(6050, "EUR")).toBe("€0.61");
    expect(createI18n("en-GB").money(20000, "EUR")).toBe("€2.00");
    expect(plain(createI18n("de-DE").money(7139, "EUR"))).toBe("0,71 €");
    expect(createI18n("ja-JP").money(150000, "JPY")).toBe("￥15");
  });

  it("formats power, distance and numbers", () => {
    const en = createI18n("en-US");
    const de = createI18n("de-DE");
    expect(en.kw(150)).toBe("150 kW");
    expect(en.kw(7.4)).toBe("7.4 kW");
    expect(de.kw(7.4)).toBe("7,4 kW");
    expect(en.distance(412)).toBe("410 m");
    expect(en.distance(2_440)).toBe("2.4 km");
    expect(de.distance(2_440)).toBe("2,4 km");
    expect(en.distance(25_000)).toBe("25 km");
  });

  it("formats opening times in the locale's clock", () => {
    expect(createI18n("en-GB").clock("07:00")).toBe("07:00");
    expect(createI18n("en-US").clock("23:00")).toMatch(/^11:00\sPM$/);
    expect(createI18n("en-GB").weekday(1)).toBe("Mon");
    expect(createI18n("de-DE").weekday(7)).toMatch(/^So\.?$/);
  });
});

describe("presenting places", () => {
  const p = present(createI18n("en-GB"));
  const place = {
    available_count: 0,
    evse_count: 2,
    status_counts: { OUTOFORDER: 2 },
    price: {
      free: false,
      summary: "",
      currency: "EUR",
      lead: { type: "ENERGY", unit: "kWh", priceE4: 4719, vatIncluded: true },
    },
  } as unknown as LocationSummary;

  it("leads with the energy price, or says no fee", () => {
    expect(p.lead(place.price)).toEqual({ amount: "€0.47", unit: "per kWh" });
    expect(p.lead({ free: true, summary: "Free" })).toEqual({
      amount: "No fee",
      unit: "",
    });
    expect(p.lead(null)).toEqual({ amount: "Price not shared", unit: "" });
    // An older server without a structured price: its own words.
    expect(p.lead({ free: false, summary: "€0.40 per kWh" }).amount).toBe(
      "€0.40 per kWh",
    );
  });

  it("shows our computed price, and the CPO's own text only without one", () => {
    const energy: DisplayComponent = {
      type: "ENERGY",
      unit: "kWh",
      priceE4: 7139,
      vatIncluded: true,
      text: "",
      conditions: [],
    };
    const priced = {
      tariffId: "T1",
      currency: "EUR",
      free: false,
      components: [energy],
      altText: "0.59 per kWh.",
      summary: "",
    };
    const shown = p.detailPrice(priced);
    expect(shown.amount).toBe("€0.71 per kWh");
    expect(shown.vat).toBe("VAT included");
    expect(shown.operatorNote).toBeUndefined();
    const unstructured = p.detailPrice({ ...priced, components: [] });
    expect(unstructured.amount).toBe("Price not shared");
    expect(unstructured.operatorNote).toBe(
      "The operator's note: 0.59 per kWh.",
    );
  });

  describe("the price of a connector", () => {
    const rate = (
      type: DisplayComponent["type"],
      priceE4: number,
      conditions: string[] = [],
      vatIncluded = true,
    ): DisplayComponent => ({
      type,
      unit: type === "ENERGY" ? "kWh" : type === "FLAT" ? "session" : "hour",
      priceE4,
      vatIncluded,
      text: "",
      conditions,
    });
    const priced = (
      components: DisplayComponent[],
      now?: DisplayPrice["now"],
      extra: Partial<DisplayPrice> = {},
    ): DisplayPrice => ({
      tariffId: "T1",
      currency: "EUR",
      free: false,
      components,
      now,
      summary: "",
      ...extra,
    });

    it("gives every kind that applies now equal weight, then the fee", () => {
      const energy = rate("ENERGY", 1100);
      const time = rate("TIME", 6600);
      const fee = rate("FLAT", 5000);
      const night = rate("ENERGY", 900, ["22:00–06:00"]);
      const shown = p.detailPrice(
        priced(
          [night, energy, time, fee],
          {
            components: [energy, time, fee],
            others: [night],
            unexplained: false,
          },
          { minPrice: "€0.50", maxPrice: "€30.00", altText: "Our words." },
        ),
      );
      expect(shown).toEqual({
        amount: "€0.11 per kWh + €0.66 per hour",
        tiers: [],
        session: "plus €0.50 per session",
        conditions: [],
        others: ["€0.09 per kWh (22:00–06:00)"],
        min: "Minimum €0.50",
        max: "At most €30.00",
        vat: "VAT included",
        unexplained: undefined,
        operatorNote: undefined,
        // The confirm screen: the same line and fee; it lists `others` under their
        // own label, as the page does.
        lines: [
          "€0.11 per kWh + €0.66 per hour",
          "plus €0.50 per session",
          "Minimum €0.50",
          "At most €30.00",
          "VAT included",
        ],
      });
    });

    it("says that other rates are not explained, in the operator's words", () => {
      // 6 TIME and 2 ENERGY components without restrictions, as the server sends them.
      const components = [
        rate("TIME", 6600, [], false),
        rate("TIME", 12000, [], false),
        rate("TIME", 18000, [], false),
        rate("ENERGY", 1100, [], false),
        rate("TIME", 24000, [], false),
        rate("TIME", 30000, [], false),
        rate("ENERGY", 2200, [], false),
        rate("TIME", 36000, [], false),
      ];
      const shown = p.detailPrice(
        priced(
          components,
          {
            components: [components[3], components[0]],
            others: [],
            unexplained: true,
          },
          { altText: "Peak and off-peak.", minPrice: "€0.50 excl. VAT" },
        ),
      );
      expect(shown).toMatchObject({
        amount: "€0.11 per kWh + €0.66 per hour",
        others: [],
        min: "Minimum €0.50 excl. VAT",
        vat: "excluding VAT",
        unexplained:
          "This operator lists other rates without saying when they apply.",
        operatorNote: "The operator's note: Peak and off-peak.",
      });
    });

    it("lists a fee that starts after 2 h apart from what applies now", () => {
      const energy = rate("ENERGY", 4000);
      const later = rate("TIME", 30000, ["after 2 h"]);
      const shown = p.detailPrice(
        priced([energy, later], {
          components: [energy],
          others: [later],
          unexplained: false,
        }),
      );
      expect(shown.amount).toBe("€0.40 per kWh");
      // The page and the confirm screen both list it.
      expect(shown.others).toEqual(["€3.00 per hour (after 2 h)"]);
      expect(shown.lines).toEqual(["€0.40 per kWh", "VAT included"]);
    });

    it("shows a power tier beside what applies now, on the page and confirm screen", () => {
      // [ENERGY €0.60 at 50 kW or more], [ENERGY €0.40]: a fast charge pays €0.60.
      const fast = rate("ENERGY", 6000, ["at 50 kW or more"]);
      const energy = rate("ENERGY", 4000);
      const shown = p.detailPrice(
        priced([fast, energy], {
          components: [energy],
          tiers: [fast],
          others: [],
          unexplained: false,
        }),
      );
      expect(shown).toMatchObject({
        amount: "€0.40 per kWh",
        tiers: ["€0.60 per kWh instead, at 50 kW or more"],
        others: [],
        lines: [
          "€0.40 per kWh",
          "€0.60 per kWh instead, at 50 kW or more",
          "VAT included",
        ],
      });
      // [ENERGY €0.30 below 11 kW], [ENERGY €0.50].
      const slow = rate("ENERGY", 3000, ["below 11 kW"]);
      const normal = rate("ENERGY", 5000);
      expect(
        p.detailPrice(
          priced([slow, normal], {
            components: [normal],
            tiers: [slow],
            others: [],
            unexplained: false,
          }),
        ).lines,
      ).toEqual([
        "€0.50 per kWh",
        "€0.30 per kWh instead, below 11 kW",
        "VAT included",
      ]);
    });

    it("from an older server, shows a conditional rate placed first as a tier", () => {
      const shown = p.detailPrice(
        priced([
          rate("ENERGY", 6000, ["at 50 kW or more"]),
          rate("ENERGY", 4000),
          rate("ENERGY", 9000, ["while reserved"]),
        ]),
      );
      expect(shown).toMatchObject({
        amount: "€0.40 per kWh",
        tiers: ["€0.60 per kWh instead, at 50 kW or more"],
        others: ["€0.90 per kWh (while reserved)"],
      });
    });

    it("says when the rates that apply now do, and shows a free first period", () => {
      const free = rate("TIME", 0, ["first 30 min"]);
      const parking = rate("PARKING_TIME", 0);
      const later = rate("TIME", 20000, ["otherwise"]);
      const shown = p.detailPrice(
        priced([free, parking, later], {
          components: [free, parking],
          others: [later],
          unexplained: false,
        }),
      );
      // Parking costs nothing at any time: it is not mentioned.
      expect(shown.amount).toBe("€0.00 per hour");
      expect(shown.conditions).toEqual(["per hour: first 30 min"]);
      expect(shown.others).toEqual(["€2.00 per hour (otherwise)"]);
    });

    it("leads with the fee when nothing else applies, or says it depends", () => {
      const fee = rate("FLAT", 5000);
      const later = rate("TIME", 20000, ["after 2 h"]);
      expect(
        p.detailPrice(
          priced([fee, later], {
            components: [fee],
            others: [later],
            unexplained: false,
          }),
        ),
      ).toMatchObject({ amount: "€0.50 per session", session: undefined });
      expect(
        p.detailPrice(
          priced([later], {
            components: [],
            others: [later],
            unexplained: false,
          }),
        ),
      ).toMatchObject({
        amount: "Depends on time and use",
        vat: "VAT included",
        others: ["€2.00 per hour (after 2 h)"],
        lines: ["Depends on time and use", "VAT included"],
      });
    });

    it("marks each rate when only some include VAT", () => {
      const energy = rate("ENERGY", 4000);
      const time = rate("TIME", 6000, [], false);
      const shown = p.detailPrice(
        priced([energy, time], {
          components: [energy, time],
          others: [],
          unexplained: false,
        }),
      );
      expect(shown.amount).toBe(
        "€0.40 per kWh incl. VAT + €0.60 per hour excl. VAT",
      );
      expect(shown.vat).toBe("");
    });

    it("says no fee for a free tariff", () => {
      const zero = rate("ENERGY", 0);
      expect(
        p.detailPrice(
          priced(
            [zero],
            { components: [zero], others: [], unexplained: false },
            { free: true },
          ),
        ),
      ).toMatchObject({ amount: "No fee", others: [], vat: "" });
    });

    it("from an older server, shows as applying only what is complete", () => {
      // Every kind has a rate without conditions.
      expect(
        p.detailPrice(
          priced([
            rate("FLAT", 5000),
            rate("ENERGY", 4000),
            rate("ENERGY", 9000),
          ]),
        ),
      ).toMatchObject({
        amount: "€0.40 per kWh",
        session: "plus €0.50 per session",
        others: [],
        unexplained:
          "This operator lists other rates without saying when they apply.",
      });
      // The time rate has a condition: the energy price alone would mislead.
      expect(
        p.detailPrice(
          priced([rate("ENERGY", 7139), rate("TIME", 72600, ["after 45 min"])]),
        ),
      ).toMatchObject({
        amount: "Depends on time and use",
        others: ["€0.71 per kWh", "€7.26 per hour (after 45 min)"],
        unexplained: undefined,
      });
    });
  });

  it("says the status in words, never by colour alone", () => {
    expect(p.availability(place)).toEqual({
      kind: "down",
      text: "Out of order",
    });
    expect(p.availability({ ...place, available_count: 1 })).toEqual({
      kind: "free",
      text: "1 of 2 free",
    });
    expect(p.connector("IEC_62196_T2_COMBO")).toBe("CCS");
    expect(p.connector("SOMETHING_NEW")).toBe("Other plug");
  });

  // The OCPI 2.2.1 list the server validates against (the packages share no code).
  const standards = [
    ...readFileSync(join(root, "../server/lib/ocpi/locations.ts"), "utf8")
      .match(/export const CONNECTOR_TYPES = \[([^\]]*)\] as const;/)![1]
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);

  it("names every connector standard the server accepts", () => {
    // OCPI 2.2.1 has this many: a shorter list means the reading above broke.
    expect(standards.length).toBeGreaterThanOrEqual(40);
    expect(
      standards.filter((s) =>
        ["", `connector.${s}`, "Other plug"].includes(p.connector(s)),
      ),
    ).toEqual([]);
    // Two standards never read the same.
    expect(new Set(standards.map(p.connector)).size).toBe(standards.length);
    // No name for a value the server would refuse, such as a misspelt key.
    expect(
      Object.keys(en).filter(
        (k) =>
          k.startsWith("connector.") &&
          k !== "connector.other" &&
          !standards.includes(k.slice("connector.".length)),
      ),
    ).toEqual([]);
    expect(p.connector("DOMESTIC_B")).toBe("Type B (US household)");
    expect(p.connector("DOMESTIC_F")).toBe("Schuko");
  });

  const weekdays = {
    opening_times: {
      twentyfourseven: false,
      regular_hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        period_begin: "07:00",
        period_end: "23:00",
      })),
    },
    time_zone: "Europe/Amsterdam",
  };

  it("groups opening hours by day", () => {
    const hours = p.hours(
      weekdays,
      new Date("2026-10-25T10:00:00Z"), // a Sunday
      "Europe/Amsterdam",
    );
    expect(hours).toEqual({
      current: { state: "closed", label: "Closed now" },
      lines: ["Mon–Sat  07:00–23:00", "Sun  Closed"],
      exceptions: [],
      zoneNote: undefined,
    });
    expect(
      p.hours({
        opening_times: { twentyfourseven: true },
        time_zone: "Europe/Amsterdam",
      }).lines,
    ).toEqual(["Open 24 hours, every day"]);
  });

  it("says a closed site can still charge only when the CPO says so", () => {
    const sunday = new Date("2026-10-25T10:00:00Z");
    const monday = new Date("2026-10-26T10:00:00Z");
    const can = { ...weekdays, charging_when_closed: true };
    const cannot = { ...weekdays, charging_when_closed: false };
    expect(p.hours(can, sunday).current).toEqual({
      state: "closedCanCharge",
      label: "Site closed now · a charge in progress can continue",
    });
    expect(p.hours(cannot, sunday).current).toEqual({
      state: "closed",
      label: "Closed now",
    });
    for (const place of [can, cannot])
      expect(p.hours(place, monday).current).toEqual({
        state: "open",
        label: "Open now",
      });
  });

  it("keeps an exceptional closing plain Closed now, even with the flag", () => {
    const monday = new Date("2026-10-26T10:00:00Z");
    const shut = {
      ...weekdays,
      charging_when_closed: true,
      opening_times: {
        ...weekdays.opening_times,
        exceptional_closings: [
          {
            period_begin: "2026-10-26T00:00:00Z",
            period_end: "2026-10-27T00:00:00Z",
          },
        ],
      },
    };
    expect(p.hours(shut, monday).current).toEqual({
      state: "closed",
      label: "Closed now",
    });
  });

  it("marks a closed place on its list card, keeping the free count", () => {
    const sunday = new Date("2026-10-25T10:00:00Z");
    const monday = new Date("2026-10-26T10:00:00Z");
    const place = {
      ...weekdays,
      available_count: 1,
      evse_count: 1,
    } as Parameters<typeof p.availability>[0];
    for (const charging_when_closed of [true, false, undefined]) {
      const l = { ...place, charging_when_closed };
      expect(p.closedNote(l, sunday)).toBe("Closed now");
      expect(p.closedNote(l, monday)).toBeUndefined();
      expect(p.availability(l).text).toBe("1 of 1 free");
    }
    expect(
      p.closedNote({ time_zone: "UTC", charging_when_closed: true }, sunday),
    ).toBeUndefined();
  });
});

describe("exceptional openings and closings", () => {
  afterEach(() => void vi.unstubAllEnvs());
  const p = present(createI18n("en-GB"));
  const period = (period_begin: string, period_end: string) => ({
    period_begin,
    period_end,
  });
  const place = {
    time_zone: "Europe/Berlin",
    opening_times: {
      twentyfourseven: true,
      exceptional_closings: [
        // Christmas Eve in Berlin, which starts on the 23rd in UTC.
        period("2026-12-23T23:00:00Z", "2026-12-24T23:00:00Z"),
        period("2026-11-01T08:00:00Z", "2026-11-01T10:00:00Z"),
        period("2026-12-01T13:00:00Z", "2026-12-01T17:00:00Z"),
      ],
      exceptional_openings: [
        period("2026-12-06T09:00:00Z", "2026-12-06T15:00:00Z"),
        period("2026-10-04T09:00:00Z", "2026-10-04T15:00:00Z"),
      ],
    },
  };
  const now = new Date("2026-11-25T10:00:00Z");

  it("lists those to come, soonest first, in the place's time zone", () => {
    const hours = p.hours(place, now);
    expect(hours.lines).toEqual(["Open 24 hours, every day"]);
    expect(hours.exceptions).toEqual([
      "Closed: 1 Dec 2026, 14:00–18:00",
      "Open: 6 Dec 2026, 10:00–16:00",
      "Closed: 24 Dec 2026, 00:00 – 25 Dec 2026, 00:00",
    ]);
  });

  it("keeps one in progress and drops it once it ends", () => {
    const listed = (at: string) => p.hours(place, new Date(at)).exceptions;
    expect(listed("2026-12-01T16:59:59Z")[0]).toBe(
      "Closed: 1 Dec 2026, 14:00–18:00",
    );
    expect(listed("2026-12-01T17:00:00Z")[0]).toBe(
      "Open: 6 Dec 2026, 10:00–16:00",
    );
    expect(listed("2026-12-25T00:00:00Z")).toEqual([]);
  });

  it("writes dates and times the driver's way", () => {
    const exceptions = present(createI18n("de-DE")).hours(
      place,
      now,
    ).exceptions;
    expect(exceptions[0]).toBe("Closed: 01.12.2026, 14:00–18:00");
    expect(
      present(createI18n("en-US")).hours(place, now).exceptions[1],
    ).toMatch(/^Open: Dec 6, 2026, 10:00\sAM–4:00\sPM$/);
  });

  it("lists them under regular hours too, once each, skipping unreadable ones", () => {
    const shut = period("2026-12-01T13:00:00Z", "2026-12-01T17:00:00Z");
    const hours = p.hours(
      {
        time_zone: "Europe/Berlin",
        opening_times: {
          twentyfourseven: false,
          regular_hours: [
            { weekday: 1, period_begin: "07:00", period_end: "23:00" },
          ],
          exceptional_closings: [
            shut,
            shut,
            period("soon", "2026-12-02T00:00:00Z"),
            period("2026-12-03T10:00:00Z", "2026-12-03T10:00:00Z"),
          ],
        },
      },
      now,
    );
    expect(hours.lines).toContain("Mon  07:00–23:00");
    expect(hours.exceptions).toEqual(["Closed: 1 Dec 2026, 14:00–18:00"]);
  });

  it("lists none without opening times", () => {
    expect(p.hours({ time_zone: "Europe/Berlin" }, now).exceptions).toEqual([]);
  });

  it("reads a time without a zone as UTC, as OCPI does", () => {
    vi.stubEnv("TZ", "America/New_York");
    const bare = {
      time_zone: "Europe/Berlin",
      opening_times: {
        twentyfourseven: true,
        exceptional_closings: [
          period("2026-12-01T13:00:00", "2026-12-01T17:00:00"),
        ],
      },
    };
    const at = new Date("2026-12-01T13:30:00Z");
    expect(p.hours(bare, at).current?.state).toBe("closed");
    expect(p.hours(bare, at).exceptions).toEqual([
      "Closed: 1 Dec 2026, 14:00–18:00",
    ]);
  });

  it("still lists them for a time zone the device does not know", () => {
    const hours = p.hours({ ...place, time_zone: "Nowhere/Nothing" }, now);
    expect(hours.exceptions).toHaveLength(3);
  });
});

describe("a long list of exceptional periods", () => {
  const p = present(createI18n("en-GB"));
  const now = new Date("2026-11-25T10:00:00Z");
  const day = 24 * 3600 * 1000;
  // 50 closings, one a week from last week on.
  const closings = Array.from({ length: 50 }, (_, n) => {
    const begin = now.getTime() + (n - 1) * 7 * day;
    return {
      period_begin: new Date(begin).toISOString(),
      period_end: new Date(begin + 2 * 3600 * 1000).toISOString(),
    };
  });
  const place = (exceptional_closings: typeof closings) => ({
    time_zone: "Europe/Berlin",
    opening_times: { twentyfourseven: true, exceptional_closings },
  });

  it("shows only the next five", () => {
    const listed = upcomingExceptions(place(closings).opening_times, now);
    expect(MAX_EXCEPTIONS).toBe(5);
    expect(listed).toHaveLength(5);
    // The one from last week is over; the list starts with this week's.
    expect(listed[0].begin).toBe(now.getTime());
    expect(listed.map((x) => x.begin)).toEqual(
      [0, 1, 2, 3, 4].map((n) => now.getTime() + n * 7 * day),
    );
    expect(p.hours(place(closings), now, "Europe/Berlin").exceptions).toEqual([
      "Closed: 25 Nov 2026, 11:00–13:00",
      "Closed: 2 Dec 2026, 11:00–13:00",
      "Closed: 9 Dec 2026, 11:00–13:00",
      "Closed: 16 Dec 2026, 11:00–13:00",
      "Closed: 23 Dec 2026, 11:00–13:00",
    ]);
  });

  it("shows none that begin more than 12 months ahead, whichever is fewer", () => {
    // Every 20 weeks: now, in 20 and 40 weeks, then 60 weeks (past 12 months) and on.
    const sparse = closings.filter((_, n) => n >= 1 && (n - 1) % 20 === 0);
    expect(sparse).toHaveLength(3);
    const far = sparse.concat(
      [60, 80].map((weeks) => {
        const begin = now.getTime() + weeks * 7 * day;
        return {
          period_begin: new Date(begin).toISOString(),
          period_end: new Date(begin + day).toISOString(),
        };
      }),
    );
    expect(
      upcomingExceptions(place(far).opening_times, now).map((x) => x.begin),
    ).toEqual([0, 20, 40].map((w) => now.getTime() + w * 7 * day));
  });

  it("counts a period sent twice once", () => {
    const twice = closings.slice(1, 4).flatMap((c) => [c, c]);
    expect(upcomingExceptions(place(twice).opening_times, now)).toHaveLength(3);
  });
});

describe("the clock the times are on", () => {
  afterEach(() => void vi.unstubAllEnvs());
  const now = new Date("2026-11-25T10:00:00Z");
  const p = present(createI18n("en-GB"));
  const regular = {
    time_zone: "Europe/Berlin",
    opening_times: {
      twentyfourseven: false,
      regular_hours: [
        { weekday: 1, period_begin: "07:00", period_end: "23:00" },
      ],
    },
  };
  const closing = {
    time_zone: "Europe/Berlin",
    opening_times: {
      twentyfourseven: true,
      exceptional_closings: [
        {
          period_begin: "2026-12-01T13:00:00Z",
          period_end: "2026-12-01T17:00:00Z",
        },
      ],
    },
  };

  it("says nothing when the device is in the site's zone", () => {
    expect(p.hours(regular, now, "Europe/Berlin").zoneNote).toBeUndefined();
    expect(p.hours(closing, now, "Europe/Berlin").zoneNote).toBeUndefined();
  });

  it("names the site's zone when the device is elsewhere", () => {
    expect(p.hours(regular, now, "America/New_York").zoneNote).toBe(
      "Times are local to the site (CET).",
    );
    const hours = p.hours(closing, now, "Europe/London");
    expect(hours.zoneNote).toBe("Times are local to the site (CET).");
    // The times themselves stay on the site's clock.
    expect(hours.exceptions).toEqual(["Closed: 1 Dec 2026, 14:00–18:00"]);
    // In summer the site's zone has its summer name.
    expect(
      p.hours(regular, new Date("2026-07-01T10:00:00Z"), "Europe/London")
        .zoneNote,
    ).toBe("Times are local to the site (CEST).");
  });

  it("says nothing when there are no times to show", () => {
    const away = "America/New_York";
    expect(
      p.hours(
        { ...closing, opening_times: { twentyfourseven: true } },
        now,
        away,
      ).zoneNote,
    ).toBeUndefined();
    expect(
      p.hours({ time_zone: "Europe/Berlin" }, now, away).zoneNote,
    ).toBeUndefined();
  });

  it("says the device's clock is used when the site's zone is unknown", () => {
    vi.stubEnv("TZ", "UTC");
    const unknown = { ...closing, time_zone: "Nowhere/Nothing" };
    const hours = p.hours(unknown, now, "UTC");
    expect(hours.exceptions).toEqual(["Closed: 1 Dec 2026, 13:00–17:00"]);
    expect(hours.zoneNote).toBe(
      "The site's time zone is not known, so exceptional hours are in your device's time (UTC).",
    );
    // Regular hours are the site's wall clock whatever the zone: nothing to say.
    expect(
      p.hours({ ...regular, time_zone: "Nowhere/Nothing" }, now, "UTC")
        .zoneNote,
    ).toBeUndefined();
  });
});

describe("a place's address", () => {
  afterEach(() => void vi.unstubAllGlobals());
  const place = {
    address: "Teststrasse 1",
    postal_code: "10115",
    city: "Berlin",
    country: "DEU",
  };

  it("has the postal code and the country's name in the driver's language", () => {
    expect(present(createI18n("en-GB")).address(place)).toBe(
      "Teststrasse 1, 10115 Berlin, Germany",
    );
    expect(present(createI18n("de-DE")).address(place)).toBe(
      "Teststrasse 1, 10115 Berlin, Deutschland",
    );
  });

  it("leaves out a postal code the CPO did not send", () => {
    expect(
      present(createI18n("en-GB")).address({
        ...place,
        postal_code: undefined,
      }),
    ).toBe("Teststrasse 1, Berlin, Germany");
  });

  it("keeps a code it cannot name", () => {
    const i = createI18n("en-GB");
    expect(i.country("ZZZ")).toBe("ZZZ");
    expect(i.country("XKX")).toBe("Kosovo");
  });

  it("keeps the code on a device without Intl.DisplayNames", () => {
    // Everything else of Intl, as on an engine without this one.
    vi.stubGlobal(
      "Intl",
      Object.create(Intl, { DisplayNames: { value: undefined } }),
    );
    expect(createI18n("en-GB").country("DEU")).toBe("DEU");
  });

  it("names every ISO 3166-1 country", () => {
    const codes = readFileSync(join(root, "src/lib/country.ts"), "utf8")
      .match(/const CODES = `([^`]*)`/)![1]
      .trim()
      .split(/\s+/)
      .map((pair) => pair.slice(0, 3));
    // ISO 3166-1 has 249 countries; XKX is the one extra.
    expect(new Set(codes).size).toBe(250);
    const i = createI18n("en-GB");
    expect(codes.filter((c) => i.country(c) === c)).toEqual([]);
    expect(["NLD", "CAN", "USA", "CHE", "AUT"].map(i.country)).toEqual([
      "Netherlands",
      "Canada",
      "United States",
      "Switzerland",
      "Austria",
    ]);
  });
});
