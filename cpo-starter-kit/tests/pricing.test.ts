import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currencyExponent,
  formatMinor,
  formatMinorDecimal,
  minorToMajorString,
  parseMajor,
} from "@/lib/money";
import type { Role } from "@/lib/roles";
import { createDemoClient, memoryDemoFleet } from "@/lib/server/ivora/demo";
import { demoSimulate } from "@/lib/server/ivora/demo-pricing";
import { IvoraError, tariffProblems } from "@/lib/server/ivora/errors";
import { resetIvoraForTests } from "@/lib/server/ivora";
import { createLiveClient } from "@/lib/server/ivora/live";
import type {
  DayOfWeek,
  IvoraClient,
  Quote,
  SessionProfile,
  Station,
  Tariff,
  TariffArchived,
  TariffDefinitionInput,
  TariffInput,
} from "@/lib/server/ivora/types";
import {
  createDemoPricingStore,
  decodeDemoPricing,
  demoPricingSeed,
  encodeDemoPricing,
  memoryDemoPricing,
} from "@/lib/server/pricing/demo";
import { tariffFormSchema, type TariffForm } from "@/lib/server/pricing/input";
import {
  connectorPricing,
  currentVersion,
  discardPendingVersion,
  effectiveTariff,
  loadPricing,
  pendingVersion,
  previewTariff,
  pricingProgress,
  publishTariff,
  saveTariff,
  sessionProfile,
  setStationPricing,
  type PricingDeps,
} from "@/lib/server/pricing/service";
import {
  definitionInput,
  describeDays,
  elementsFor,
  generatedDriverText,
  overlappingPeriods,
  PAID_HOLD_MINOR,
  pricedElements,
  samePrices,
  tariffInput,
} from "@/lib/server/pricing/tariff";
import {
  elapsedMinutes,
  localTimeExists,
  zonedToUtc,
} from "@/lib/server/pricing/time";
import {
  PricingError,
  type TariffDefinition,
} from "@/lib/server/pricing/types";
import type { Staff } from "@/lib/server/team/types";

// Pricing runs against the in-memory demo store and a fake Ivora client with mode
// "live" (or the live client over a fake fetch), so the live branches (versions,
// keys, refusals, uncertain answers) are covered with no network or credentials.

const OPERATOR = "10000000-0000-4000-8000-0000000000aa";
function staff(role: Role): Staff {
  return {
    userId: `00000000-0000-4000-8000-00000000000${role.length}`,
    email: `${role}@example.com`,
    role,
    operatorId: OPERATOR,
    operatorName: "Sample Operator",
    demo: false,
  };
}
const owner = staff("owner");
const manager = staff("manager");
const technician = staff("technician");
const viewer = staff("viewer");

const PAID: TariffDefinition = {
  kind: "paid",
  currency: "USD",
  timeZone: "UTC",
  energyMinorPerKwh: 35,
  sessionFeeMinor: 100,
  idleMinorPerMinute: 40,
  idleGraceMinutes: 10,
  periods: [
    {
      days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
      start: "16:00",
      end: "21:00",
      energyMinorPerKwh: 45,
    },
  ],
  driverText: null,
};

const FORM: TariffForm = {
  name: "Standard",
  kind: "paid",
  timeZone: "UTC",
  energy: "0.35",
  sessionFee: "1.00",
  idleFee: "0.40",
  idleGrace: "10",
  driverText: "",
  periods: [
    {
      start: "16:00",
      end: "21:00",
      price: "0.45",
      days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    },
  ],
};

/** Tuesday, 20 October 2026. */
const SIM = {
  date: "2026-10-20",
  start: "18:00",
  end: "20:30",
  energyKwh: "30",
  idleMinutes: "15",
};

describe("money", () => {
  it("parses typed amounts into integer minor units without floating point", () => {
    expect(parseMajor("0.35", "USD")).toBe(35);
    expect(parseMajor("$1", "USD")).toBe(100);
    expect(parseMajor("12.5", "USD")).toBe(1250);
    expect(parseMajor("0.1", "USD")! + parseMajor("0.2", "USD")!).toBe(30);
    expect(parseMajor("0.355", "USD")).toBeNull();
    expect(parseMajor("-1", "USD")).toBeNull();
    expect(parseMajor("1e3", "USD")).toBeNull();
    expect(parseMajor("500", "JPY")).toBe(500);
    expect(parseMajor("5.5", "JPY")).toBeNull();
    expect(currencyExponent("KWD")).toBe(3);
    expect(parseMajor("1.250", "KWD")).toBe(1250);
  });

  it("formats minor units exactly", () => {
    expect(minorToMajorString(35, "USD")).toBe("0.35");
    expect(minorToMajorString(2500, "USD")).toBe("25.00");
    expect(minorToMajorString(7, "JPY")).toBe("7");
    expect(formatMinor(1650, "USD")).toBe("$16.50");
    expect(formatMinor(1650, "EUR")).toBe("€16.50");
    expect(formatMinorDecimal("45", "USD")).toBe("$0.45");
    expect(formatMinorDecimal("2400.000000", "USD")).toBe("$24.00");
    expect(formatMinorDecimal("0.6667", "USD")).toBe("$0.006667");
    expect(() => minorToMajorString(0.5, "USD")).toThrow();
  });
});

describe("tariff elements", () => {
  it("puts time-of-use periods first, then the base price with the fees", () => {
    expect(elementsFor(PAID)).toEqual([
      {
        price_components: [{ type: "ENERGY", price: 0.45, step_size: 1 }],
        restrictions: {
          start_time: "16:00",
          end_time: "21:00",
          day_of_week: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
        },
      },
      {
        price_components: [
          { type: "ENERGY", price: 0.35, step_size: 1 },
          { type: "FLAT", price: 1 },
          // Per hour (OCPI), billed per started minute.
          { type: "PARKING_TIME", price: 24, step_size: 60 },
        ],
      },
    ]);
  });

  it("leaves out days for an every-day period, and fees that are zero", () => {
    const def: TariffDefinition = {
      ...PAID,
      sessionFeeMinor: 0,
      idleMinorPerMinute: 0,
      periods: [
        {
          ...PAID.periods[0],
          days: [
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
            "SUNDAY",
          ],
          start: "22:00",
          end: "06:00",
          energyMinorPerKwh: 20,
        },
      ],
    };
    expect(elementsFor(def)).toEqual([
      {
        price_components: [{ type: "ENERGY", price: 0.2, step_size: 1 }],
        restrictions: { start_time: "22:00", end_time: "06:00" },
      },
      { price_components: [{ type: "ENERGY", price: 0.35, step_size: 1 }] },
    ]);
  });

  it("makes a free tariff one zero-price element with no hold", () => {
    const free: TariffDefinition = { ...PAID, kind: "free" };
    expect(elementsFor(free)).toEqual([
      { price_components: [{ type: "ENERGY", price: 0, step_size: 1 }] },
    ]);
    expect(tariffInput(free, "t1", 1).authorization_minor).toBe(0);
    expect(tariffInput(PAID, "t1", 1).authorization_minor).toBe(
      PAID_HOLD_MINOR,
    );
    expect(generatedDriverText(free)).toBe("Free charging.");
  });

  it("sends time_zone, driver text, the hold and our reference", () => {
    const input = tariffInput(PAID, "abc", 3);
    expect(input).toMatchObject({
      currency: "USD",
      time_zone: "UTC",
      authorization_minor: 2500,
      external_reference: "cpo-tariff-abc-v3",
    });
    expect(input.tariff_alt_text).toEqual([
      {
        language: "en",
        text: "$0.35 per kWh; $0.45 per kWh Mon–Fri 16:00–21:00; $1.00 session fee; idle fee $0.40 per minute plugged in but not charging, after the first 10 idle minutes. Times are UTC local time.",
      },
    ]);
    // The simulation takes the same definition without the hold or reference.
    expect(Object.keys(definitionInput(PAID)).sort()).toEqual([
      "currency",
      "elements",
      "rules",
      "tariff_alt_text",
      "time_zone",
    ]);
    expect(
      tariffInput({ ...PAID, driverText: "Own words." }, "abc", 3)
        .tariff_alt_text,
    ).toEqual([{ language: "en", text: "Own words." }]);
  });

  it("sends the idle grace period to Ivora as its rule, never as fewer minutes", () => {
    expect(definitionInput(PAID).rules).toEqual({ idle_grace_minutes: 10 });
    expect(tariffInput(PAID, "abc", 1).rules).toEqual({
      idle_grace_minutes: 10,
    });
    expect(definitionInput(PAID, { withGrace: false }).rules).toBeUndefined();
    // No grace, or no idle fee: no rule.
    expect(
      definitionInput({ ...PAID, idleGraceMinutes: 0 }).rules,
    ).toBeUndefined();
    expect(
      definitionInput({ ...PAID, idleMinorPerMinute: 0 }).rules,
    ).toBeUndefined();
    expect(
      generatedDriverText({ ...PAID, idleGraceMinutes: 0, periods: [] }),
    ).toBe(
      "$0.35 per kWh; $1.00 session fee; idle fee $0.40 per minute plugged in but not charging. Times are UTC local time.",
    );
  });

  it("splits an overnight period on chosen days into the local days it covers", () => {
    const night = (days: DayOfWeek[]): TariffDefinition => ({
      ...PAID,
      sessionFeeMinor: 0,
      idleMinorPerMinute: 0,
      periods: [{ days, start: "22:00", end: "06:00", energyMinorPerKwh: 20 }],
    });
    const energy = [{ type: "ENERGY", price: 0.2, step_size: 1 }];
    // Fri 22:00-06:00 is Friday from 22:00 and Saturday until 06:00.
    expect(elementsFor(night(["FRIDAY"]))).toEqual([
      {
        price_components: energy,
        restrictions: { start_time: "22:00", day_of_week: ["FRIDAY"] },
      },
      {
        price_components: energy,
        restrictions: { end_time: "06:00", day_of_week: ["SATURDAY"] },
      },
      { price_components: [{ type: "ENERGY", price: 0.35, step_size: 1 }] },
    ]);
    // Sunday night runs into Monday morning.
    expect(elementsFor(night(["SATURDAY", "SUNDAY"]))[1].restrictions).toEqual({
      end_time: "06:00",
      day_of_week: ["MONDAY", "SUNDAY"],
    });
    // Until midnight is one element.
    expect(
      elementsFor({
        ...night(["FRIDAY"]),
        periods: [
          {
            days: ["FRIDAY"],
            start: "22:00",
            end: "00:00",
            energyMinorPerKwh: 20,
          },
        ],
      }),
    ).toHaveLength(2);
    // Each element knows its period, for the preview's labels.
    expect(pricedElements(night(["FRIDAY"])).map((x) => x.period)).toEqual([
      0,
      0,
      null,
    ]);
  });

  it("prices Friday night's Saturday hours at the period price, and Friday morning at the base", () => {
    const def: TariffDefinition = {
      ...PAID,
      sessionFeeMinor: 0,
      idleMinorPerMinute: 0,
      periods: [
        {
          days: ["FRIDAY"],
          start: "22:00",
          end: "06:00",
          energyMinorPerKwh: 20,
        },
      ],
    };
    const at = (start_at: string) =>
      demoSimulate(definitionInput(def), {
        start_at,
        time_zone: "UTC",
        duration_minutes: 60,
        energy_kwh: 10,
        idle_minutes: 0,
      }).total_minor;
    expect(at("2026-10-24T01:00:00.000Z")).toBe(200); // Saturday 01:00
    expect(at("2026-10-23T01:00:00.000Z")).toBe(350); // Friday 01:00
    expect(at("2026-10-23T23:00:00.000Z")).toBe(200); // Friday 23:00
    expect(at("2026-10-24T23:00:00.000Z")).toBe(350); // Saturday 23:00
  });

  it("tells when only the driver text differs", () => {
    expect(samePrices(PAID, { ...PAID, driverText: "Own words." })).toBe(true);
    expect(samePrices(PAID, { ...PAID, energyMinorPerKwh: 36 })).toBe(false);
    expect(samePrices(PAID, { ...PAID, idleGraceMinutes: 5 })).toBe(false);
    expect(
      samePrices(PAID, {
        ...PAID,
        periods: [{ ...PAID.periods[0], end: "22:00" }],
      }),
    ).toBe(false);
  });

  it("describes days and finds overlapping periods, across midnight too", () => {
    expect(describeDays(["MONDAY", "TUESDAY", "WEDNESDAY"])).toBe("Mon–Wed");
    expect(describeDays(["SATURDAY", "SUNDAY"])).toBe("Sat, Sun");
    expect(describeDays(["MONDAY", "WEDNESDAY"])).toBe("Mon, Wed");
    const p = (start: string, end: string, days: DayOfWeek[] = ["MONDAY"]) => ({
      start,
      end,
      days: [...days],
      energyMinorPerKwh: 1,
    });
    expect(
      overlappingPeriods([p("16:00", "21:00"), p("21:00", "23:00")]),
    ).toEqual([]);
    // Monday night's early hours are Tuesday's.
    expect(
      overlappingPeriods([p("22:00", "06:00"), p("05:00", "07:00")]),
    ).toEqual([]);
    expect(
      overlappingPeriods([
        p("22:00", "06:00"),
        p("05:00", "07:00", ["TUESDAY"]),
      ]),
    ).toEqual([[0, 1, "TUESDAY"]]);
    // Sunday night runs into Monday.
    expect(
      overlappingPeriods([
        p("22:00", "02:00", ["SUNDAY"]),
        p("01:00", "03:00", ["MONDAY"]),
      ]),
    ).toEqual([[0, 1, "MONDAY"]]);
    expect(
      overlappingPeriods([
        p("16:00", "21:00"),
        p("17:00", "18:00", ["SUNDAY"]),
      ]),
    ).toEqual([]);
  });
});

describe("tariff form", () => {
  const parse = (f: TariffForm, currency = "USD") =>
    tariffFormSchema(currency).safeParse(f);

  it("reads the editor into a definition in integer minor units", () => {
    const r = parse(FORM);
    expect(r.success && r.data).toEqual({ name: "Standard", definition: PAID });
  });

  it("defaults the idle grace to 10 minutes, and drops it without an idle fee", () => {
    const r = parse({ ...FORM, idleGrace: "" });
    expect(r.success && r.data.definition.idleGraceMinutes).toBe(10);
    const none = parse({ ...FORM, idleFee: "" });
    expect(none.success && none.data.definition).toMatchObject({
      idleMinorPerMinute: 0,
      idleGraceMinutes: 0,
    });
  });

  it("refuses sub-cent amounts, overlaps and periods without days", () => {
    const issues = (f: TariffForm) => {
      const r = parse(f);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(issues({ ...FORM, energy: "0.355" })[0]).toMatch(
      /at most 2 decimals/,
    );
    expect(issues({ ...FORM, energy: "" })[0]).toMatch(/price per kWh/);
    expect(
      issues({
        ...FORM,
        periods: [
          FORM.periods![0],
          { start: "20:00", end: "22:00", price: "0.50", days: ["FRIDAY"] },
        ],
      }),
    ).toEqual([
      expect.stringMatching(/Periods 1 and 2 overlap \(on Fridays\)/),
    ]);
    expect(
      issues({
        ...FORM,
        periods: [{ start: "10:00", end: "12:00", price: "0.3", days: [] }],
      }),
    ).toEqual([expect.stringMatching(/choose at least one day/)]);
    expect(issues({ ...FORM, idleGrace: "-5" })[0]).toMatch(/grace/);
    expect(issues({ ...FORM, name: " " })[0]).toMatch(/Name the tariff/);
  });

  it("keeps paid tariffs in US dollars, the currency of the card hold", () => {
    const r = parse(FORM, "JPY");
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].message).toMatch(
      /Paid tariffs are in USD/,
    );
    // Free tariffs hold and charge nothing, in any currency.
    expect(parse({ ...FORM, kind: "free" }, "EUR").success).toBe(true);
  });

  it("makes a free tariff zero whatever the price fields say", () => {
    const r = parse({ ...FORM, kind: "free" });
    expect(r.success && r.data.definition).toMatchObject({
      kind: "free",
      energyMinorPerKwh: 0,
      sessionFeeMinor: 0,
      idleMinorPerMinute: 0,
      periods: [],
    });
  });
});

describe("local time", () => {
  it("turns a local time into UTC, with daylight saving", () => {
    expect(
      zonedToUtc("2026-07-01", "18:00", "America/New_York").toISOString(),
    ).toBe("2026-07-01T22:00:00.000Z");
    expect(
      zonedToUtc("2026-12-01", "18:00", "America/New_York").toISOString(),
    ).toBe("2026-12-01T23:00:00.000Z");
    expect(zonedToUtc("2026-10-20", "18:00", "UTC").toISOString()).toBe(
      "2026-10-20T18:00:00.000Z",
    );
    expect(elapsedMinutes("2026-10-20", "18:00", "20:30", "UTC")).toBe(150);
    expect(elapsedMinutes("2026-10-20", "23:00", "01:00", "UTC")).toBe(120);
  });

  it("handles the US spring-forward gap and fall-back repeat the same way every time", () => {
    const ny = "America/New_York";
    // 8 March 2026: 02:00 EST jumps to 03:00 EDT.
    expect(localTimeExists("2026-03-08", "02:30", ny)).toBe(false);
    expect(zonedToUtc("2026-03-08", "02:30", ny).toISOString()).toBe(
      "2026-03-08T07:30:00.000Z", // 03:30 EDT
    );
    expect(zonedToUtc("2026-03-08", "01:59", ny).toISOString()).toBe(
      "2026-03-08T06:59:00.000Z",
    );
    expect(zonedToUtc("2026-03-08", "03:00", ny).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    // Real elapsed time: 01:00 to 03:00 is one hour that night.
    expect(elapsedMinutes("2026-03-08", "01:00", "03:00", ny)).toBe(60);
    // 1 November 2026: 01:00-02:00 happens twice; the first (EDT) is taken.
    expect(localTimeExists("2026-11-01", "01:30", ny)).toBe(true);
    expect(zonedToUtc("2026-11-01", "01:30", ny).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(elapsedMinutes("2026-11-01", "01:00", "03:00", ny)).toBe(180);
    // Overnight across the change.
    expect(elapsedMinutes("2026-10-31", "23:00", "02:00", ny)).toBe(240);
  });

  it("handles the EU changes the same way", () => {
    const berlin = "Europe/Berlin";
    // 29 March 2026: 02:00 CET jumps to 03:00 CEST.
    expect(localTimeExists("2026-03-29", "02:30", berlin)).toBe(false);
    expect(zonedToUtc("2026-03-29", "02:30", berlin).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z", // 03:30 CEST
    );
    expect(elapsedMinutes("2026-03-29", "01:00", "03:00", berlin)).toBe(60);
    // 25 October 2026: 02:00-03:00 happens twice; the first (CEST) is taken.
    expect(zonedToUtc("2026-10-25", "02:30", berlin).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(elapsedMinutes("2026-10-25", "01:00", "04:00", berlin)).toBe(240);
    // London, in a zone that is UTC in winter.
    expect(
      zonedToUtc("2026-03-29", "01:30", "Europe/London").toISOString(),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("refuses a preview that starts or ends in a spring-forward gap", () => {
    const s = {
      date: "2026-03-08",
      start: "02:30",
      end: "04:00",
      energyKwh: 10,
      idleMinutes: 0,
    };
    const def = { ...PAID, timeZone: "America/New_York" };
    expect(() => sessionProfile(def, s)).toThrow(/does not happen/);
    // An overnight session ending in the gap, the next morning.
    expect(() =>
      sessionProfile(def, {
        ...s,
        date: "2026-03-07",
        start: "23:00",
        end: "02:30",
      }),
    ).toThrow(/02:30 does not happen on 2026-03-08/);
    expect(
      sessionProfile(def, { ...s, start: "01:00", end: "03:00" })
        .duration_minutes,
    ).toBe(60);
  });

  it("sends every idle minute to Ivora, which applies the grace period", () => {
    const s = {
      date: "2026-10-20",
      start: "18:00",
      end: "20:30",
      energyKwh: 30,
      idleMinutes: 15,
    };
    expect(sessionProfile(PAID, s)).toEqual({
      start_at: "2026-10-20T18:00:00.000Z",
      time_zone: "UTC",
      duration_minutes: 150,
      energy_kwh: 30,
      idle_minutes: 15,
    });
    expect(sessionProfile(PAID, { ...s, idleMinutes: 8 }).idle_minutes).toBe(8);
  });
});

describe("demo simulation", () => {
  const session = (o: Partial<SessionProfile> = {}): SessionProfile => ({
    start_at: "2026-10-20T18:00:00.000Z",
    time_zone: "UTC",
    duration_minutes: 150,
    energy_kwh: 30,
    idle_minutes: 5,
    ...o,
  });

  it("prices a 30 kWh session from 18:00 to 20:30 at the peak price", () => {
    const q = demoSimulate(
      definitionInput(PAID),
      session({ idle_minutes: 15 }),
    );
    expect(
      q.lines.map((l) => [l.type, l.element, l.quantity, l.amount_minor]),
    ).toEqual([
      ["ENERGY", 0, "30.000000", 1350],
      ["FLAT", 1, "1", 100],
      ["PARKING_TIME", 1, "0.083333", 200],
    ]);
    expect(q.total_minor).toBe(1650);
    expect(q.lines[0].price_minor).toBe("45.000000");
    // The first 10 of the 15 idle minutes are free, and the answer says so.
    expect(q.idle_free_seconds).toBe(600);
    // Without the rule, every idle minute is billed and nothing is reported.
    const plain = demoSimulate(
      definitionInput(PAID, { withGrace: false }),
      session({ idle_minutes: 15 }),
    );
    expect(plain.total_minor).toBe(1350 + 100 + 600);
    expect(plain.idle_free_seconds).toBeUndefined();
  });

  it("splits energy where a period ends, and prices weekends at the base", () => {
    const q = demoSimulate(
      definitionInput(PAID),
      session({
        start_at: "2026-10-20T20:00:00.000Z",
        duration_minutes: 120,
        energy_kwh: 20,
        idle_minutes: 0,
      }),
    );
    expect(q.lines.map((l) => [l.element, l.quantity, l.amount_minor])).toEqual(
      [
        [0, "10.000000", 450],
        [1, "10.000000", 350],
        [1, "1", 100],
      ],
    );
    expect(q.total_minor).toBe(900);
    // Saturday 24 October: no period applies.
    const sat = demoSimulate(
      definitionInput(PAID),
      session({ start_at: "2026-10-24T18:00:00.000Z", idle_minutes: 0 }),
    );
    expect(sat.total_minor).toBe(30 * 35 + 100);
  });

  it("keeps exact amounts and rounds the total once", () => {
    const q = demoSimulate(
      definitionInput({
        ...PAID,
        periods: [],
        sessionFeeMinor: 0,
        energyMinorPerKwh: 33,
      }),
      session({ energy_kwh: 0.015, idle_minutes: 0 }),
    );
    expect(q.lines[0].exact_minor).toBe("0.495000");
    expect(q.total_minor).toBe(0);
    const free = demoSimulate(
      definitionInput({ ...PAID, kind: "free" }),
      session(),
    );
    expect(free.total_minor).toBe(0);
  });

  it("refuses what it can't price, like the API's 422", () => {
    const bad: TariffDefinitionInput = {
      ...definitionInput(PAID),
      elements: [{ price_components: [{ type: "TIME", price: 1 }] }],
    };
    let e: unknown;
    try {
      demoSimulate(bad, session());
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(IvoraError);
    expect((e as IvoraError).code).toBe("tariff_invalid");
    expect(tariffProblems(e)).toEqual([
      "Demo mode does not price charging time (TIME).",
    ]);
  });
});

// ---- The live client over a fake fetch ----

const API_KEY = "test-key-not-real";
type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const header = (c: Call, name: string) =>
  new Headers(c.init.headers as Record<string, string>).get(name);

describe("live client tariffs", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.IVORA_API_KEY = API_KEY;
    process.env.IVORA_TENANT_ID = "42";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    delete process.env.DEMO_MODE;
    resetIvoraForTests();
    vi.stubGlobal("fetch", () => {
      throw new Error("tests must not reach the network");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });
  const client = (api: ReturnType<typeof fakeFetch>) =>
    createLiveClient({
      baseUrl: "https://api.example.test",
      apiKey: API_KEY,
      tenantId: "42",
      fetch: api.fetch,
      sleep: async () => {},
    });

  it("creates a tariff with our key, and adopts it by reference after an unknown outcome", async () => {
    const record = {
      id: 77,
      currency: "USD",
      rate_minor_per_kwh: 35,
      authorization_minor: 2500,
    };
    const api = fakeFetch([
      json(503, {
        error: { code: "outcome_unknown", message: "?" },
        request_id: "r1",
      }),
      json(503, {
        error: { code: "outcome_unknown", message: "?" },
        request_id: "r2",
      }),
      json(503, {
        error: { code: "outcome_unknown", message: "?" },
        request_id: "r3",
      }),
      json(503, {
        error: { code: "outcome_unknown", message: "?" },
        request_id: "r4",
      }),
      json(200, { data: [record], next_cursor: 0 }),
    ]);
    const input = tariffInput(PAID, "abc", 2);
    const t = await client(api).createTariff(input, "cpo-tariff-abc-v2-create");
    expect(t.id).toBe(77);
    const posts = api.calls.filter((c) => c.init.method === "POST");
    expect(posts).toHaveLength(4);
    for (const c of posts) {
      expect(c.url).toBe("https://api.example.test/v1/tenants/42/tariffs");
      // The same key and body on every try.
      expect(header(c, "idempotency-key")).toBe("cpo-tariff-abc-v2-create");
      expect(JSON.parse(String(c.init.body))).toEqual(input);
    }
    expect(api.calls[4].url).toBe(
      "https://api.example.test/v1/tenants/42/tariffs?limit=1&external_reference=cpo-tariff-abc-v2",
    );
  });

  it("archives with the replacement, and simulates without a key", async () => {
    const quote = {
      currency: "USD",
      pricing_version: "elements-v1",
      lines: [],
      subtotal_minor: 0,
      exact_subtotal_minor: "0",
      adjustments: [],
      total_minor: 0,
      prepaid: null,
    };
    const api = fakeFetch([
      json(200, {
        id: 70,
        archived: true,
        replacement_tariff_id: 77,
        reassigned_connectors: [5],
      }),
      json(200, quote),
      json(422, {
        error: {
          code: "tariff_invalid",
          message: "The tariff is invalid",
          details: {
            errors: [
              {
                element: 1,
                field: "restrictions",
                message: "hidden by element 0",
              },
            ],
          },
        },
        request_id: "r9",
      }),
    ]);
    const c = client(api);
    const a = await c.archiveTariff(70, 77, "cpo-tariff-abc-v1-archive");
    expect(a.reassigned_connectors).toEqual([5]);
    expect(api.calls[0].init.method).toBe("DELETE");
    expect(api.calls[0].url).toBe(
      "https://api.example.test/v1/tenants/42/tariffs/70?replacement_tariff_id=77",
    );
    expect(header(api.calls[0], "idempotency-key")).toBe(
      "cpo-tariff-abc-v1-archive",
    );
    const session = sessionProfile(PAID, {
      ...SIM,
      energyKwh: 30,
      idleMinutes: 15,
    });
    await c.simulateTariff(definitionInput(PAID), session);
    expect(api.calls[1].url).toBe(
      "https://api.example.test/v1/tenants/42/tariffs/simulate",
    );
    expect(header(api.calls[1], "idempotency-key")).toBeNull();
    const err = await c
      .simulateTariff(definitionInput(PAID), session)
      .catch((e: unknown) => e);
    expect(tariffProblems(err)).toEqual([
      "element 1, restrictions: hidden by element 0",
    ]);
  });
});

// ---- The service, with a fake live Ivora client ----

const STATION: Station = {
  id: 9101,
  name: "SAMPLE-01",
  online: true,
  location_id: 9001,
  connectors: [
    { id: 91011, number: 1, status: "Available", tariff_id: null },
    { id: 91012, number: 2, status: "Available", tariff_id: 12 },
  ],
};

const QUOTE: Quote = {
  currency: "USD",
  pricing_version: "elements-v1",
  // Ivora's own numbers: shown as they are, never recomputed.
  lines: [
    {
      type: "ENERGY",
      element: 0,
      reservation: false,
      quantity: "30.000000",
      unit: "kWh",
      price_minor: "45",
      exact_minor: "1350.000000",
      amount_minor: 1350,
    },
    {
      type: "FLAT",
      element: 1,
      reservation: false,
      quantity: "1",
      unit: "session",
      price_minor: "100",
      exact_minor: "100.000000",
      amount_minor: 100,
    },
    {
      type: "PARKING_TIME",
      element: 1,
      reservation: false,
      quantity: "0.083333",
      unit: "h",
      price_minor: "2400",
      exact_minor: "200.000000",
      amount_minor: 200,
    },
  ],
  subtotal_minor: 1650,
  exact_subtotal_minor: "1650.000000",
  adjustments: [],
  total_minor: 1651,
};

/**
 * A fake Ivora. `graceRule: false` is an API without rules.idle_grace_minutes: like
 * the published OpenAPI, it refuses the unknown field.
 */
function fakeIvora({ graceRule = true } = {}) {
  let next = 500;
  const created: TariffInput[] = [];
  const byReference = new Map<string, Tariff>();
  const really = async (input: TariffInput, _key: string): Promise<Tariff> => {
    created.push(input);
    const t: Tariff = {
      id: ++next,
      currency: input.currency,
      rate_minor_per_kwh: 0,
      authorization_minor: input.authorization_minor,
      external_reference: input.external_reference,
      archived: false,
    };
    byReference.set(input.external_reference, t);
    return { ...t };
  };
  const api = {
    mode: "live" as const,
    createTariff: vi.fn(really),
    findTariff: vi.fn(async (ref: string): Promise<Tariff | null> => {
      const t = byReference.get(ref);
      return t ? { ...t } : null;
    }),
    archiveTariff: vi.fn(
      async (
        id: number,
        replacement: number | null,
        _key: string,
      ): Promise<TariffArchived> => {
        for (const t of byReference.values())
          if (t.id === id) t.archived = true;
        return {
          id,
          archived: true,
          replacement_tariff_id: replacement,
          reassigned_connectors: [],
        };
      },
    ),
    simulateTariff: vi.fn(
      async (t: TariffDefinitionInput, _s: SessionProfile): Promise<Quote> => {
        if (t.rules && !graceRule)
          throw new IvoraError(
            422,
            "validation_error",
            "Request body is invalid",
            "req_v",
            undefined,
            {
              errors: [
                {
                  field: "tariff.rules.idle_grace_minutes",
                  message: "Extra inputs are not permitted",
                },
              ],
            },
          );
        const grace = t.rules?.idle_grace_minutes;
        return {
          ...structuredClone(QUOTE),
          ...(grace !== undefined ? { idle_free_seconds: grace * 60 } : {}),
        };
      },
    ),
    getStation: vi.fn(async (id: number) => {
      if (id !== STATION.id)
        throw new IvoraError(404, "station_not_found", "Unknown station");
      return structuredClone(STATION);
    }),
    listAllStations: vi.fn(async () => ({
      data: [structuredClone(STATION)],
      truncated: false,
    })),
    listAllLocations: vi.fn(async () => ({
      data: [{ id: 9001, name: "Sample Site" }],
      truncated: false,
    })),
  };
  return { api, created, really, client: api as unknown as IvoraClient };
}

function deps(o: { graceRule?: boolean } = {}) {
  const cookie = memoryDemoPricing({ v: 1, tariffs: [], stations: [] });
  const ivora = fakeIvora(o);
  const d: PricingDeps = {
    store: createDemoPricingStore(cookie),
    ivora: ivora.client,
    company: {
      load: async () => ({ currency: "USD", timeZone: "UTC" }) as never,
    },
  };
  return { d, cookie, ...ivora };
}

const unknownOutcome = () =>
  new IvoraError(503, "outcome_unknown", "Unknown", "req_2");

const tariffOf = async (d: PricingDeps, id: string) =>
  (await d.store.load(OPERATOR)).tariffs.find((t) => t.id === id)!;

/** Saves a new version from a form loaded now (with the tariff's revision). */
const edit = async (d: PricingDeps, who: Staff, form: TariffForm, id: string) =>
  saveTariff(
    d,
    who,
    { ...form, revision: String((await tariffOf(d, id)).revision) },
    id,
  );

const stationRevision = async (d: PricingDeps, stationId = 9101) =>
  String(
    (await d.store.load(OPERATOR)).stations.find(
      (s) => s.stationId === stationId,
    )?.revision ?? 0,
  );

describe("pricing service", () => {
  it("is for owners and managers only", async () => {
    const { d } = deps();
    for (const who of [technician, viewer]) {
      await expect(saveTariff(d, who, FORM)).rejects.toThrow(
        /owners and managers/,
      );
      await expect(previewTariff(d, who, FORM, SIM)).rejects.toThrow(
        /owners and managers/,
      );
      await expect(loadPricing(d, who)).rejects.toThrow(/owners and managers/);
      await expect(
        setStationPricing(d, who, {
          stationId: "9101",
          revision: "0",
          tariffId: "",
        }),
      ).rejects.toThrow(/owners and managers/);
      await expect(discardPendingVersion(d, who, "x")).rejects.toThrow(
        /owners and managers/,
      );
    }
    // The store refuses too, on its own.
    await expect(d.store.createTariff(technician, "x", PAID)).rejects.toThrow(
      /owners and managers/,
    );
  });

  it("creates a tariff as version 1 in Ivora, with keys from our record", async () => {
    const { d, api, created } = deps();
    const { id, result } = await saveTariff(d, owner, FORM);
    expect(result).toEqual({ state: "saved", version: 1, warning: undefined });
    expect(api.createTariff).toHaveBeenCalledWith(
      expect.objectContaining({ external_reference: `cpo-tariff-${id}-v1` }),
      `cpo-tariff-${id}-v1-a1-create`,
    );
    expect(created[0]).toEqual(tariffInput(PAID, id, 1));
    const t = (await d.store.load(OPERATOR)).tariffs[0];
    expect(currentVersion(t)).toMatchObject({ version: 1, ivoraTariffId: 501 });
    // A first save sends the create straight away: no lookup.
    expect(api.findTariff).not.toHaveBeenCalled();
  });

  it("saves a change as a new version and archives the old one with it as replacement", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    const r = await edit(d, manager, { ...FORM, energy: "0.40" }, id);
    expect(r.result).toMatchObject({ state: "saved", version: 2 });
    expect(api.createTariff).toHaveBeenLastCalledWith(
      expect.objectContaining({ external_reference: `cpo-tariff-${id}-v2` }),
      `cpo-tariff-${id}-v2-a1-create`,
    );
    // The old Ivora tariff is never edited: archived, its connectors moved to v2.
    expect(api.archiveTariff).toHaveBeenCalledWith(
      501,
      502,
      `cpo-tariff-${id}-v1-archive-to-v2`,
    );
    const t = (await d.store.load(OPERATOR)).tariffs[0];
    expect(
      t.versions.map((v) => [
        v.version,
        v.ivoraTariffId,
        Boolean(v.archivedAt),
      ]),
    ).toEqual([
      [2, 502, false],
      [1, 501, true],
    ]);
    expect(t.versions[0].definition?.energyMinorPerKwh).toBe(40);
    // The client has no way to change a tariff in place.
    expect("updateTariff" in api).toBe(false);
  });

  it("drops a version Ivora refuses and shows every problem", async () => {
    const { d, api } = deps();
    api.createTariff.mockRejectedValueOnce(
      new IvoraError(
        422,
        "tariff_invalid",
        "Invalid tariff",
        "req_1",
        undefined,
        {
          errors: [
            { element: 0, field: "restrictions", message: "first" },
            { element: 1, message: "second" },
          ],
        },
      ),
    );
    const e = await saveTariff(d, owner, FORM).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PricingError);
    expect((e as PricingError).problems).toEqual([
      "element 0, restrictions: first",
      "element 1: second",
    ]);
    // Nothing was created in Ivora, so the new tariff is gone again.
    expect((await d.store.load(OPERATOR)).tariffs).toEqual([]);
  });

  it("never reuses a version number, so no key is sent with a second body", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    api.createTariff.mockRejectedValueOnce(
      new IvoraError(422, "tariff_invalid", "Invalid tariff"),
    );
    await expect(
      edit(d, owner, { ...FORM, energy: "0.40" }, id),
    ).rejects.toThrow(/tariff_invalid/);
    const r = await edit(d, owner, { ...FORM, energy: "0.41" }, id);
    expect(r.result).toMatchObject({ state: "saved", version: 3 });
    expect(api.createTariff.mock.calls.map((c) => c[1])).toEqual([
      `cpo-tariff-${id}-v1-a1-create`,
      `cpo-tariff-${id}-v2-a1-create`,
      `cpo-tariff-${id}-v3-a1-create`,
    ]);
    expect((await tariffOf(d, id)).versions.map((v) => v.version)).toEqual([
      3, 1,
    ]);
  });

  it("keeps an unconfirmed version, refuses another save, and retries as a new attempt once Ivora has none", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    api.createTariff.mockRejectedValueOnce(unknownOutcome());
    const r = await edit(d, owner, { ...FORM, energy: "0.50" }, id);
    expect(r.result.state).toBe("unconfirmed");
    let t = await tariffOf(d, id);
    expect(pendingVersion(t)?.version).toBe(2);
    // Drivers keep version 1 meanwhile.
    expect(currentVersion(t)?.version).toBe(1);
    await expect(edit(d, owner, FORM, id)).rejects.toThrow(/Finish saving/);
    // The retried key would only replay "unknown": each retry is a new attempt.
    api.createTariff.mockRejectedValueOnce(unknownOutcome());
    expect(await publishTariff(d, owner, id)).toMatchObject({
      state: "unconfirmed",
      version: 2,
    });
    expect(await publishTariff(d, owner, id)).toMatchObject({
      state: "saved",
      version: 2,
    });
    expect(api.findTariff.mock.calls).toEqual([
      [`cpo-tariff-${id}-v2`],
      [`cpo-tariff-${id}-v2`],
    ]);
    const calls = api.createTariff.mock.calls;
    expect(calls.map((c) => c[1])).toEqual([
      `cpo-tariff-${id}-v1-a1-create`,
      `cpo-tariff-${id}-v2-a1-create`,
      `cpo-tariff-${id}-v2-a2-create`,
      `cpo-tariff-${id}-v2-a3-create`,
    ]);
    // Every attempt sends the same body.
    expect(calls[2][0]).toEqual(calls[1][0]);
    expect(calls[3][0]).toEqual(calls[1][0]);
    t = await tariffOf(d, id);
    expect(pendingVersion(t)).toBeNull();
    expect(currentVersion(t)?.version).toBe(2);
  });

  it("adopts a version Ivora created when its answer was lost", async () => {
    const { d, api, really } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    api.createTariff.mockImplementationOnce(async (input, key) => {
      await really(input, key);
      throw unknownOutcome();
    });
    const r = await edit(d, owner, { ...FORM, energy: "0.50" }, id);
    expect(r.result.state).toBe("unconfirmed");
    expect(await publishTariff(d, owner, id)).toMatchObject({
      state: "saved",
      version: 2,
    });
    // Found by its reference: not sent again.
    expect(api.createTariff).toHaveBeenCalledTimes(2);
    expect(currentVersion(await tariffOf(d, id))?.ivoraTariffId).toBe(502);
    expect(api.archiveTariff).toHaveBeenCalledWith(
      501,
      502,
      `cpo-tariff-${id}-v1-archive-to-v2`,
    );
  });

  it("keeps the version as it is when Ivora can't be asked about it", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    api.createTariff.mockRejectedValueOnce(unknownOutcome());
    await edit(d, owner, { ...FORM, energy: "0.50" }, id);
    for (const e of [
      new IvoraError(503, "unavailable", "Busy"),
      new IvoraError(403, "forbidden", "Missing permission"),
    ]) {
      api.findTariff.mockRejectedValueOnce(e);
      expect(await publishTariff(d, owner, id)).toMatchObject({
        state: "unconfirmed",
        version: 2,
      });
    }
    const t = await tariffOf(d, id);
    // Not dropped, and no new attempt was used up.
    expect(pendingVersion(t)).toMatchObject({ version: 2, attempt: 1 });
    expect(api.createTariff).toHaveBeenCalledTimes(2);
  });

  it("discards an unconfirmed draft, archiving anything Ivora made for it", async () => {
    const { d, api, really } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    await expect(discardPendingVersion(d, owner, id)).rejects.toThrow(
      /no unconfirmed version/,
    );
    // Ivora has nothing for the draft: it is simply forgotten.
    api.createTariff.mockRejectedValueOnce(unknownOutcome());
    await edit(d, owner, { ...FORM, energy: "0.50" }, id);
    expect(await discardPendingVersion(d, manager, id)).toEqual({
      version: 2,
      tariffRemoved: false,
    });
    expect(api.archiveTariff).not.toHaveBeenCalled();
    let t = await tariffOf(d, id);
    expect(pendingVersion(t)).toBeNull();
    expect(currentVersion(t)?.version).toBe(1);
    // Ivora made it after all: archived (nothing uses it), then forgotten.
    api.createTariff.mockImplementationOnce(async (input, key) => {
      await really(input, key);
      throw unknownOutcome();
    });
    await edit(d, owner, { ...FORM, energy: "0.55" }, id);
    await discardPendingVersion(d, owner, id);
    expect(api.archiveTariff).toHaveBeenCalledWith(
      502,
      null,
      `cpo-tariff-${id}-v3-discard`,
    );
    t = await tariffOf(d, id);
    expect(t.versions.map((v) => v.version)).toEqual([1]);
    // The next version is 4: numbers 2 and 3 are never used again.
    expect(
      (await edit(d, owner, { ...FORM, energy: "0.60" }, id)).result,
    ).toMatchObject({ state: "saved", version: 4 });
    // A new tariff whose only version is discarded goes with it.
    api.createTariff.mockRejectedValueOnce(unknownOutcome());
    const fresh = await saveTariff(d, owner, { ...FORM, name: "Other" });
    expect(await discardPendingVersion(d, owner, fresh.id)).toEqual({
      version: 1,
      tariffRemoved: true,
    });
    expect((await d.store.load(OPERATOR)).tariffs.map((x) => x.id)).toEqual([
      id,
    ]);
    // If Ivora can't be asked, the draft is kept.
    api.createTariff.mockRejectedValueOnce(unknownOutcome());
    await edit(d, owner, { ...FORM, energy: "0.65" }, id);
    api.findTariff.mockRejectedValueOnce(
      new IvoraError(0, "network_error", "Lost"),
    );
    await expect(discardPendingVersion(d, owner, id)).rejects.toThrow(
      /draft is kept/,
    );
    expect(pendingVersion(await tariffOf(d, id))?.version).toBe(5);
  });

  it("refuses a save from an editor opened before someone else's change", async () => {
    const { d } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    // A and B both open version 1 ($0.35).
    const opened = String((await tariffOf(d, id)).revision);
    // A raises the price to $0.45.
    await saveTariff(
      d,
      owner,
      { ...FORM, energy: "0.45", revision: opened },
      id,
    );
    // B, on the old form, changes only the idle fee: refused, nothing changes.
    await expect(
      saveTariff(
        d,
        manager,
        { ...FORM, idleFee: "0.50", revision: opened },
        id,
      ),
    ).rejects.toThrow(/Someone changed this tariff/);
    const t = await tariffOf(d, id);
    expect(currentVersion(t)).toMatchObject({ version: 2 });
    expect(currentVersion(t)?.definition?.energyMinorPerKwh).toBe(45);
    // A form without a revision is refused too.
    await expect(saveTariff(d, owner, FORM, id)).rejects.toThrow(/out of date/);
    // Reloaded, B's change goes through on top of A's.
    const r = await edit(
      d,
      manager,
      { ...FORM, energy: "0.45", idleFee: "0.50" },
      id,
    );
    expect(r.result).toMatchObject({ state: "saved", version: 3 });
  });

  it("asks to confirm the operator's own driver text when the prices change", async () => {
    const { d } = deps();
    const own = { ...FORM, driverText: "Own words: $0.35 per kWh." };
    const { id } = await saveTariff(d, owner, own);
    await expect(
      edit(d, owner, { ...own, energy: "0.40" }, id),
    ).rejects.toThrow(/prices changed, but your text for drivers did not/);
    // Confirmed, changed or cleared: saved.
    await edit(
      d,
      owner,
      { ...own, energy: "0.40", driverTextConfirmed: "on" },
      id,
    );
    await edit(
      d,
      owner,
      { ...own, energy: "0.41", driverText: "Own words: $0.41 per kWh." },
      id,
    );
    await edit(d, owner, { ...own, energy: "0.42", driverText: "" }, id);
    // Same prices (a new name only): nothing to confirm.
    const t = await tariffOf(d, id);
    expect(currentVersion(t)?.definition?.driverText).toBeNull();
    await edit(d, owner, { ...own, energy: "0.42", name: "Renamed" }, id);
    await edit(d, owner, { ...own, energy: "0.42", name: "Renamed again" }, id);
  });

  it("warns when an old version could not be archived, and retries it", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    api.archiveTariff.mockRejectedValueOnce(
      new IvoraError(503, "unavailable", "Busy"),
    );
    const r = await edit(d, owner, { ...FORM, energy: "0.40" }, id);
    expect(r.result).toMatchObject({ state: "saved", version: 2 });
    expect(r.result.state === "saved" && r.result.warning).toMatch(
      /Version 1 is still active/,
    );
    // Already archived counts as done.
    api.archiveTariff.mockRejectedValueOnce(
      new IvoraError(409, "tariff_archived", "Archived"),
    );
    expect(await publishTariff(d, owner, id)).toMatchObject({
      state: "saved",
      warning: undefined,
    });
    expect(api.archiveTariff.mock.calls.map((c) => c[2])).toEqual([
      `cpo-tariff-${id}-v1-archive-to-v2`,
      `cpo-tariff-${id}-v1-archive-to-v2`,
    ]);
    const t = (await d.store.load(OPERATOR)).tariffs[0];
    expect(t.versions[1].archivedAt).not.toBeNull();
  });

  it("previews with Ivora's simulation and shows its amounts as they are", async () => {
    const { d, api } = deps();
    const q = await previewTariff(d, owner, FORM, SIM);
    const [tariff, session] = api.simulateTariff.mock.calls[0];
    expect(tariff).toEqual(definitionInput(PAID));
    expect(tariff.rules).toEqual({ idle_grace_minutes: 10 });
    // Every idle minute goes to Ivora, which applies the grace period.
    expect(session).toEqual({
      start_at: "2026-10-20T18:00:00.000Z",
      time_zone: "UTC",
      duration_minutes: 150,
      energy_kwh: 30,
      idle_minutes: 15,
    });
    expect(q.total).toBe("$16.51");
    expect(q.sentence).toBe(
      "A 30 kWh session on Tue, Oct 20, 2026 from 18:00 to 20:30 (UTC), then 15 idle minutes costs $16.51.",
    );
    expect(q.lines).toEqual([
      {
        label: "Energy, period 1 (Mon–Fri 16:00–21:00)",
        quantity: "30 kWh",
        unitPrice: "$0.45/kWh",
        amount: "$13.50",
      },
      {
        label: "Session fee",
        quantity: "1",
        unitPrice: "$1.00",
        amount: "$1.00",
      },
      {
        // Both numbers are Ivora's: the free minutes and the billed quantity.
        label: "Idle fee (after 10 free minutes)",
        quantity: "5 min",
        unitPrice: "$24.00/hour",
        amount: "$2.00",
      },
    ]);
    const notes = q.notes.join(" ");
    expect(notes).toMatch(/plugged in but not charging/);
    expect(notes).toMatch(/while charging is paused/);
    expect(notes).not.toMatch(/yet/);
    expect(q.warnings).toEqual([]);
    expect(q.demo).toBe(false);
  });

  it("warns when a preview costs more than the card hold", async () => {
    const { d, api } = deps();
    // 60 kWh at $0.45, a $1.00 fee and 20 idle minutes at $0.40: $36.00.
    api.simulateTariff.mockResolvedValueOnce({
      ...structuredClone(QUOTE),
      subtotal_minor: 3600,
      total_minor: 3600,
      idle_free_seconds: 0,
    });
    const q = await previewTariff(
      d,
      owner,
      { ...FORM, idleGrace: "0" },
      { ...SIM, energyKwh: "60", idleMinutes: "20" },
    );
    expect(q.warnings).toEqual([
      expect.stringMatching(/\$36\.00, more than the \$25\.00 card hold/),
    ]);
    // A free tariff has no hold to exceed.
    api.simulateTariff.mockResolvedValueOnce({
      ...structuredClone(QUOTE),
      total_minor: 3600,
    });
    const free = await previewTariff(d, owner, { ...FORM, kind: "free" }, SIM);
    expect(free.warnings).toEqual([]);
  });

  it("refuses an idle grace period Ivora does not apply, and explains it", async () => {
    const { d, api, created } = deps({ graceRule: false });
    await expect(saveTariff(d, owner, FORM)).rejects.toThrow(
      /can't apply an idle grace period/,
    );
    await expect(previewTariff(d, owner, FORM, SIM)).rejects.toThrow(
      /Set the idle grace period to 0 minutes/,
    );
    // Nothing reached the kit's tables or Ivora's tariffs.
    expect(api.createTariff).not.toHaveBeenCalled();
    expect((await d.store.load(OPERATOR)).tariffs).toEqual([]);
    // With no grace, the idle fee bills from the first idle minute, and says so.
    const r = await saveTariff(d, owner, { ...FORM, idleGrace: "0" });
    expect(r.result.state).toBe("saved");
    expect(created[0].rules).toBeUndefined();
    expect(created[0].tariff_alt_text[0].text).toMatch(
      /idle fee \$0\.40 per minute plugged in but not charging\./,
    );
    const q = await previewTariff(d, owner, { ...FORM, idleGrace: "0" }, SIM);
    expect(q.lines[2].label).toBe("Idle fee");

    // An API that ignores the rule (no idle_free_seconds): refused too.
    const quiet = deps();
    quiet.api.simulateTariff.mockResolvedValue(structuredClone(QUOTE));
    await expect(saveTariff(quiet.d, owner, FORM)).rejects.toThrow(
      /can't apply an idle grace period/,
    );
    expect(quiet.api.createTariff).not.toHaveBeenCalled();
  });

  it("turns Ivora's validation errors into problems staff can read", async () => {
    const { d, api } = deps();
    const invalid = () =>
      new IvoraError(422, "tariff_invalid", "Invalid", undefined, undefined, {
        errors: [{ element: 0, message: "partly overlaps element 1" }],
      });
    // Refused with the grace rule and without it: the problem is the tariff's.
    api.simulateTariff
      .mockRejectedValueOnce(invalid())
      .mockRejectedValueOnce(invalid());
    const e = await previewTariff(d, owner, FORM, SIM).catch((x: unknown) => x);
    expect((e as PricingError).message).not.toMatch(/grace/);
    expect((e as PricingError).problems).toEqual([
      "element 0: partly overlaps element 1",
    ]);
    expect(api.simulateTariff.mock.calls[1][0].rules).toBeUndefined();
    await expect(
      previewTariff(d, owner, FORM, { ...SIM, end: "18:00" }),
    ).rejects.toThrow(/must differ/);
  });

  it("assigns tariffs per station and connector, and checks both in Ivora", async () => {
    const { d } = deps();
    const a = await saveTariff(d, owner, FORM);
    const b = await saveTariff(d, owner, {
      ...FORM,
      name: "Free",
      kind: "free",
    });
    await setStationPricing(d, owner, {
      stationId: "9101",
      revision: "0",
      tariffId: a.id,
      private: true,
      connectors: { "91011": "station", "91012": b.id },
    });
    const state = await d.store.load(OPERATOR);
    expect(effectiveTariff(state, 9101, 91011)).toMatchObject({
      source: "station",
      tariff: { id: a.id },
    });
    expect(effectiveTariff(state, 9101, 91012)).toMatchObject({
      source: "connector",
      tariff: { id: b.id },
    });
    const view = await loadPricing(d, owner);
    expect(view.stations[0].revision).toBe(1);
    expect(view.stations[0].connectors).toEqual([
      expect.objectContaining({
        number: 1,
        tariffName: "Standard",
        source: "station",
        ivoraTariffId: null,
      }),
      expect.objectContaining({
        number: 2,
        tariffName: "Free",
        source: "connector",
        ivoraTariffId: 12,
      }),
    ]);
    expect(view.tariffs.map((t) => [t.name, t.connectors])).toEqual([
      ["Free", 1],
      ["Standard", 1],
    ]);
    const cp = await connectorPricing(d.store, OPERATOR, 9101, 91012);
    expect(cp).toMatchObject({
      private: true,
      tariff: { name: "Free", free: true, ivoraTariffId: 502 },
    });
    expect(await pricingProgress(d.store, OPERATOR)).toEqual({
      tariffs: 2,
      assigned: 1,
    });

    await expect(
      setStationPricing(d, owner, {
        stationId: "9101",
        revision: "1",
        connectors: { "99999": a.id },
      }),
    ).rejects.toThrow(/not on this charger/);
    await expect(
      setStationPricing(d, owner, {
        stationId: "1234",
        revision: "0",
        tariffId: a.id,
      }),
    ).rejects.toThrow(/station_not_found/);
    // Clearing everything leaves the station with no tariff, public, no overrides.
    await setStationPricing(d, owner, {
      stationId: "9101",
      revision: "1",
      tariffId: "",
    });
    expect((await d.store.load(OPERATOR)).stations).toEqual([
      {
        stationId: 9101,
        tariffId: null,
        private: false,
        connectors: {},
        revision: 2,
      },
    ]);
    expect(await connectorPricing(d.store, OPERATOR, 9101, 91011)).toEqual({
      private: false,
      tariff: null,
    });
  });

  it("refuses a stale station form, so a private charger stays private", async () => {
    const { d } = deps();
    const a = await saveTariff(d, owner, FORM);
    await setStationPricing(d, owner, {
      stationId: "9101",
      revision: "0",
      tariffId: a.id,
    });
    // A and B both open the page at revision 1.
    const opened = await stationRevision(d);
    // A makes the charger private.
    await setStationPricing(d, owner, {
      stationId: "9101",
      revision: opened,
      tariffId: a.id,
      private: true,
    });
    // B's stale form (private unticked) would reopen the public checkout: refused.
    await expect(
      setStationPricing(d, manager, {
        stationId: "9101",
        revision: opened,
        tariffId: a.id,
        private: false,
      }),
    ).rejects.toThrow(/Someone changed this charger/);
    expect(
      (await connectorPricing(d.store, OPERATOR, 9101, 91011)).private,
    ).toBe(true);
    // A first save from two forms: only one of them.
    await setStationPricing(d, owner, {
      stationId: "9101",
      revision: await stationRevision(d),
      tariffId: a.id,
      private: true,
    });
    await expect(
      setStationPricing(d, owner, { stationId: "9101", tariffId: a.id }),
    ).rejects.toThrow(/out of date/);
  });

  it("refuses to assign a tariff Ivora has not confirmed", async () => {
    const { d, api } = deps();
    api.createTariff.mockRejectedValueOnce(
      new IvoraError(0, "network_error", "Lost"),
    );
    const { id, result } = await saveTariff(d, owner, FORM);
    expect(result.state).toBe("unconfirmed");
    await expect(
      setStationPricing(d, owner, {
        stationId: "9101",
        revision: "0",
        tariffId: id,
      }),
    ).rejects.toThrow(/not in Ivora yet/);
  });
});

describe("demo pricing", () => {
  it("round-trips the cookie, keeps it small and falls back to the samples", () => {
    const s = demoPricingSeed();
    expect(decodeDemoPricing(encodeDemoPricing(s))).toEqual(s);
    expect(decodeDemoPricing("%%%")).toEqual(demoPricingSeed());
    const many = structuredClone(s);
    many.tariffs[0].versions = Array.from({ length: 7 }, (_, i) => ({
      ...s.tariffs[0].versions[0],
      version: 7 - i,
      ivoraTariffId: 9411 + i,
    }));
    const back = decodeDemoPricing(encodeDemoPricing(many));
    expect(back.tariffs[0].versions).toHaveLength(5);
    // Only the current version keeps its definition.
    expect(back.tariffs[0].versions.map((v) => Boolean(v.definition))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("works end to end offline with the demo Ivora client", async () => {
    const ivora = createDemoClient(memoryDemoFleet());
    const d: PricingDeps = {
      store: createDemoPricingStore(memoryDemoPricing()),
      ivora,
      company: {
        load: async () => ({ currency: "USD", timeZone: "UTC" }) as never,
      },
    };
    const before = await loadPricing(d, owner);
    expect(before.tariffs.map((t) => t.name)).toEqual([
      "Sample: Free staff charging",
      "Sample: Standard",
    ]);
    const market = before.stations.find((s) => s.name === "DEMO-MARKET-01");
    expect(market).toMatchObject({ private: true });
    const q = await previewTariff(d, owner, FORM, SIM);
    expect(q).toMatchObject({ total: "$16.50", demo: true });
    const standard = before.tariffs.find((t) => t.name === "Sample: Standard")!;
    const r = await edit(
      d,
      owner,
      { ...FORM, name: "Sample: Standard" },
      standard.id,
    );
    expect(r.result).toMatchObject({ state: "saved", version: 2 });
    // The demo applies the grace period like Ivora, and reports it.
    expect(q.lines.at(-1)?.label).toBe("Idle fee (after 10 free minutes)");
    // The sample's Ivora tariff is archived, and archiving it again says so.
    await expect(
      ivora.archiveTariff(9401, null, "cpo-demo-archive-again"),
    ).rejects.toThrow(/Already archived/);
  });
});
