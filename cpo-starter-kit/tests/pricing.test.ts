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
  tariffInput,
} from "@/lib/server/pricing/tariff";
import { minutesBetween, zonedToUtc } from "@/lib/server/pricing/time";
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
        text: "$0.35 per kWh; $0.45 per kWh Mon–Fri 16:00–21:00; $1.00 session fee; idle fee $0.40 per minute after the first 10 minutes once charging ends. Times are UTC local time.",
      },
    ]);
    // The simulation takes the same definition without the hold or reference.
    expect(Object.keys(definitionInput(PAID)).sort()).toEqual([
      "currency",
      "elements",
      "tariff_alt_text",
      "time_zone",
    ]);
    expect(
      tariffInput({ ...PAID, driverText: "Own words." }, "abc", 3)
        .tariff_alt_text,
    ).toEqual([{ language: "en", text: "Own words." }]);
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
    expect(
      overlappingPeriods([p("22:00", "06:00"), p("05:00", "07:00")]),
    ).toEqual([[0, 1]]);
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
    ).toEqual([expect.stringMatching(/Periods 1 and 2 overlap \(Fri\)/)]);
    expect(
      issues({
        ...FORM,
        periods: [{ start: "10:00", end: "12:00", price: "0.3", days: [] }],
      }),
    ).toEqual([expect.stringMatching(/choose at least one day/)]);
    expect(issues({ ...FORM, idleGrace: "-5" })[0]).toMatch(/grace/);
    expect(issues({ ...FORM, name: " " })[0]).toMatch(/Name the tariff/);
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
    expect(minutesBetween("18:00", "20:30")).toBe(150);
    expect(minutesBetween("23:00", "01:00")).toBe(120);
  });

  it("sends the idle minutes after the grace period to Ivora", () => {
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
      idle_minutes: 5,
      billedIdleMinutes: 5,
    });
    expect(sessionProfile(PAID, { ...s, idleMinutes: 8 }).idle_minutes).toBe(0);
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
    const q = demoSimulate(definitionInput(PAID), session());
    expect(
      q.lines.map((l) => [l.type, l.element, l.quantity, l.amount_minor]),
    ).toEqual([
      ["ENERGY", 0, "30.000000", 1350],
      ["FLAT", 1, "1", 100],
      ["PARKING_TIME", 1, "0.083333", 200],
    ]);
    expect(q.total_minor).toBe(1650);
    expect(q.lines[0].price_minor).toBe("45.000000");
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

function fakeIvora() {
  let next = 500;
  const created: TariffInput[] = [];
  const api = {
    mode: "live" as const,
    createTariff: vi.fn(
      async (input: TariffInput, _key: string): Promise<Tariff> => {
        created.push(input);
        return {
          id: ++next,
          currency: input.currency,
          rate_minor_per_kwh: 0,
          authorization_minor: input.authorization_minor,
        };
      },
    ),
    archiveTariff: vi.fn(
      async (
        id: number,
        replacement: number | null,
        _key: string,
      ): Promise<TariffArchived> => ({
        id,
        archived: true,
        replacement_tariff_id: replacement,
        reassigned_connectors: [],
      }),
    ),
    simulateTariff: vi.fn(
      async (
        _t: TariffDefinitionInput,
        _s: SessionProfile,
      ): Promise<Quote> => ({
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
      }),
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
  return { api, created, client: api as unknown as IvoraClient };
}

function deps() {
  const cookie = memoryDemoPricing({ v: 1, tariffs: [], stations: [] });
  const ivora = fakeIvora();
  const d: PricingDeps = {
    store: createDemoPricingStore(cookie),
    ivora: ivora.client,
    company: {
      load: async () => ({ currency: "USD", timeZone: "UTC" }) as never,
    },
  };
  return { d, cookie, ...ivora };
}

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
        setStationPricing(d, who, { stationId: "9101", tariffId: "" }),
      ).rejects.toThrow(/owners and managers/);
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
      `cpo-tariff-${id}-v1-create`,
    );
    expect(created[0]).toEqual(tariffInput(PAID, id, 1));
    const t = (await d.store.load(OPERATOR)).tariffs[0];
    expect(currentVersion(t)).toMatchObject({ version: 1, ivoraTariffId: 501 });
  });

  it("saves a change as a new version and archives the old one with it as replacement", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    const r = await saveTariff(d, manager, { ...FORM, energy: "0.40" }, id);
    expect(r.result).toMatchObject({ state: "saved", version: 2 });
    expect(api.createTariff).toHaveBeenLastCalledWith(
      expect.objectContaining({ external_reference: `cpo-tariff-${id}-v2` }),
      `cpo-tariff-${id}-v2-create`,
    );
    // The old Ivora tariff is never edited: archived, its connectors moved to v2.
    expect(api.archiveTariff).toHaveBeenCalledWith(
      501,
      502,
      `cpo-tariff-${id}-v1-archive`,
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

  it("keeps an unconfirmed version, refuses another save, and finishes with the same key", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    api.createTariff.mockRejectedValueOnce(
      new IvoraError(503, "outcome_unknown", "Unknown", "req_2"),
    );
    const r = await saveTariff(d, owner, { ...FORM, energy: "0.50" }, id);
    expect(r.result.state).toBe("unconfirmed");
    let t = (await d.store.load(OPERATOR)).tariffs[0];
    expect(pendingVersion(t)?.version).toBe(2);
    // Drivers keep version 1 meanwhile.
    expect(currentVersion(t)?.version).toBe(1);
    await expect(saveTariff(d, owner, FORM, id)).rejects.toThrow(
      /Finish saving/,
    );
    expect(await publishTariff(d, owner, id)).toMatchObject({
      state: "saved",
      version: 2,
    });
    const keys = api.createTariff.mock.calls.map((c) => c[1]);
    expect(keys).toEqual([
      `cpo-tariff-${id}-v1-create`,
      `cpo-tariff-${id}-v2-create`,
      `cpo-tariff-${id}-v2-create`,
    ]);
    t = (await d.store.load(OPERATOR)).tariffs[0];
    expect(pendingVersion(t)).toBeNull();
  });

  it("warns when an old version could not be archived, and retries it", async () => {
    const { d, api } = deps();
    const { id } = await saveTariff(d, owner, FORM);
    api.archiveTariff.mockRejectedValueOnce(
      new IvoraError(503, "unavailable", "Busy"),
    );
    const r = await saveTariff(d, owner, { ...FORM, energy: "0.40" }, id);
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
    const t = (await d.store.load(OPERATOR)).tariffs[0];
    expect(t.versions[1].archivedAt).not.toBeNull();
  });

  it("previews with Ivora's simulation and shows its amounts as they are", async () => {
    const { d, api } = deps();
    const q = await previewTariff(d, owner, FORM, SIM);
    const [tariff, session] = api.simulateTariff.mock.calls[0];
    expect(tariff).toEqual(definitionInput(PAID));
    // 15 idle minutes, the first 10 free: 5 go to Ivora.
    expect(session).toEqual({
      start_at: "2026-10-20T18:00:00.000Z",
      time_zone: "UTC",
      duration_minutes: 150,
      energy_kwh: 30,
      idle_minutes: 5,
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
        label: "Idle fee (5 of 15 idle minutes; the first 10 are free)",
        quantity: "5 min",
        unitPrice: "$24.00/hour",
        amount: "$2.00",
      },
    ]);
    expect(q.notes.join(" ")).toMatch(/do not charge idle time yet/);
    expect(q.demo).toBe(false);
  });

  it("turns Ivora's validation errors into problems staff can read", async () => {
    const { d, api } = deps();
    api.simulateTariff.mockRejectedValueOnce(
      new IvoraError(422, "tariff_invalid", "Invalid", undefined, undefined, {
        errors: [{ element: 0, message: "partly overlaps element 1" }],
      }),
    );
    const e = await previewTariff(d, owner, FORM, SIM).catch((x: unknown) => x);
    expect((e as PricingError).problems).toEqual([
      "element 0: partly overlaps element 1",
    ]);
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
        connectors: { "99999": a.id },
      }),
    ).rejects.toThrow(/not on this charger/);
    await expect(
      setStationPricing(d, owner, { stationId: "1234", tariffId: a.id }),
    ).rejects.toThrow(/station_not_found/);
    // Clearing everything removes the station's pricing.
    await setStationPricing(d, owner, { stationId: "9101", tariffId: "" });
    expect((await d.store.load(OPERATOR)).stations).toEqual([]);
  });

  it("refuses to assign a tariff Ivora has not confirmed", async () => {
    const { d, api } = deps();
    api.createTariff.mockRejectedValueOnce(
      new IvoraError(0, "network_error", "Lost"),
    );
    const { id, result } = await saveTariff(d, owner, FORM);
    expect(result.state).toBe("unconfirmed");
    await expect(
      setStationPricing(d, owner, { stationId: "9101", tariffId: id }),
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
    const r = await saveTariff(
      d,
      owner,
      { ...FORM, name: "Sample: Standard" },
      standard.id,
    );
    expect(r.result).toMatchObject({ state: "saved", version: 2 });
    // The sample's Ivora tariff is archived, and archiving it again says so.
    await expect(
      ivora.archiveTariff(9401, null, "cpo-demo-archive-again"),
    ).rejects.toThrow(/Already archived/);
  });
});
