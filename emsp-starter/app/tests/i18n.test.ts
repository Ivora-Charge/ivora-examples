import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createI18n } from "../src/i18n/core";
import en from "../src/i18n/en.json";
import { present } from "../src/lib/present";
import type { LocationSummary } from "../src/lib/types";

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
  it("formats money from ten-thousandths, with up to 4 decimals", () => {
    expect(createI18n("en-GB").money(7139, "EUR")).toBe("€0.7139");
    expect(createI18n("en-GB").money(6050, "EUR")).toBe("€0.605");
    expect(createI18n("en-GB").money(20000, "EUR")).toBe("€2.00");
    expect(plain(createI18n("de-DE").money(7139, "EUR"))).toBe("0,7139 €");
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
    expect(p.lead(place.price)).toEqual({ amount: "€0.4719", unit: "per kWh" });
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

  it("groups opening hours by day", () => {
    const hours = p.hours(
      {
        twentyfourseven: false,
        regular_hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          period_begin: "07:00",
          period_end: "23:00",
        })),
      },
      "Europe/Amsterdam",
      new Date("2026-10-25T10:00:00Z"), // a Sunday
    );
    expect(hours).toEqual({
      open: false,
      lines: ["Mon–Sat  07:00–23:00", "Sun  Closed"],
    });
    expect(
      p.hours({ twentyfourseven: true }, "Europe/Amsterdam").lines,
    ).toEqual(["Open 24 hours, every day"]);
  });
});
