import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SPEED, DEMO_START_DELAY_MS } from "@/lib/demo";
import {
  decodeDemoStore,
  demoAuthorize,
  demoConsole,
  demoCounter,
  demoGiveChange,
  demoMarkPaid,
  demoStop,
  encodeDemoStore,
  seedDemoStore,
} from "@/lib/demo-store";
import type { SaleTerms } from "@/lib/store";

const T0 = Date.parse("2026-10-20T15:00:00Z");
const settings = { idleGraceMinutes: 10 };
const PREPAY: SaleTerms = { mode: "prepay", prepaidCents: 2000, limitWh: null };
const POSTPAY: SaleTerms = {
  mode: "postpay",
  prepaidCents: null,
  limitWh: null,
};

const fetchSpy = vi.fn(() => {
  throw new Error("Demo mode must not make network requests.");
});
beforeEach(() => vi.stubGlobal("fetch", fetchSpy));
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchSpy).not.toHaveBeenCalled();
});

const tile = (
  store: ReturnType<typeof seedDemoStore>,
  code: string,
  now: number,
) => demoConsole(store, now, settings).tiles.find((t) => t.code === code)!;

describe("demo cashier console", () => {
  it("opens with sample chargers in every state", () => {
    const store = seedDemoStore(T0);
    const states = Object.fromEntries(
      demoConsole(store, T0, settings).tiles.map((t) => [t.label, t.state]),
    );
    expect(states).toEqual({
      "Charger 1-1": "available",
      "Charger 1-2": "available",
      "Charger 2-1": "card",
      "Charger 2-2": "faulted",
      "Charger 3": "plugged_in",
      "Charger 4": "plugged_in",
      "Charger 5": "charging",
      "Charger 6": "done_unpaid",
      "Charger 7": "done_unpaid",
      "Charger 8": "paid",
      "Charger 9": "offline",
      "Charger 10": "charging",
    });
    expect(tile(store, "DEMO-10", T0).warning).toMatch(/free vend/);
    expect(
      tile(store, "DEMO-6", T0).sale!.amounts!.outstandingCents,
    ).toBeGreaterThan(0);
    // The overrun sample shows extra due, recorded only up to the prepaid amount.
    const over = tile(store, "DEMO-7", T0).sale!.amounts!;
    expect(over.overrunCents).toBeGreaterThan(0);
    expect(over.collectedCents).toBe(1500);
    expect(over.payments.map((p) => p.step)).toEqual(["prepaid"]);
  });

  it("prepay with change: stops before the prepaid amount, then hands back the rest", () => {
    let store = seedDemoStore(T0);
    const requestId = "8a6e0804-2bd0-4672-b79d-d97027f55c9b";
    const first = demoAuthorize(
      store,
      { code: "DEMO-4", connector: 1, terms: PREPAY, requestId },
      T0,
      settings,
    );
    store = first.store;
    // Repeating the same request returns the same sale.
    expect(
      demoAuthorize(
        store,
        { code: "DEMO-4", connector: 1, terms: PREPAY, requestId },
        T0 + 500,
        settings,
      ).store.sales,
    ).toHaveLength(store.sales.length);
    const sim = (s: number) =>
      T0 + DEMO_START_DELAY_MS + (s * 1000) / DEMO_SPEED;
    expect(tile(store, "DEMO-4", sim(60)).state).toBe("charging");
    const later = sim(3 * 3600);
    const done = tile(store, "DEMO-4", later).sale!;
    expect(done.phase).toBe("done");
    const a = done.amounts!;
    expect(a.dueCents).toBeLessThan(2000);
    expect(a.changeCents).toBe(2000 - a.dueCents);
    expect(a.status).toBe("change");
    expect(
      demoCounter(store, "DEMO-4", 1, later, settings).sale!.amounts!
        .changeCents,
    ).toBe(a.changeCents);
    store = demoGiveChange(store, first.view.sale, later, settings).store;
    expect(tile(store, "DEMO-4", later).state).toBe("paid");
  });

  it("postpay: authorise, stop, then mark paid", () => {
    let store = seedDemoStore(T0);
    const { store: s1, view } = demoAuthorize(
      store,
      {
        code: "DEMO-3",
        connector: 1,
        terms: POSTPAY,
        requestId: "0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d",
      },
      T0,
      settings,
    );
    store = s1;
    const t = T0 + DEMO_START_DELAY_MS + 15_000;
    store = demoStop(store, view.sale, t, settings).store;
    const done = tile(store, "DEMO-3", t + 1000);
    expect(done.state).toBe("done_unpaid");
    const due = done.sale!.amounts!.outstandingCents;
    expect(() =>
      demoMarkPaid(
        store,
        {
          sale: view.sale,
          amountCents: due + 1,
          method: "cash",
          posReference: null,
        },
        t,
        settings,
      ),
    ).toThrow(/amount due/);
    store = demoMarkPaid(
      store,
      { sale: view.sale, amountCents: due, method: "cash", posReference: null },
      t,
      settings,
    ).store;
    expect(tile(store, "DEMO-3", t + 2000).state).toBe("paid");
  });

  it("refuses pay-after until the car is plugged in, and busy chargers", () => {
    const store = seedDemoStore(T0);
    const req = (code: string, terms: SaleTerms) =>
      demoAuthorize(
        store,
        {
          code,
          connector: 1,
          terms,
          requestId: "1b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d",
        },
        T0,
        settings,
      );
    expect(() => req("DEMO-1", POSTPAY)).toThrow(/plugged in/);
    expect(() => req("DEMO-5", PREPAY)).toThrow(/in progress/);
    expect(() => req("DEMO-9", PREPAY)).toThrow(/offline/);
    expect(() => req("DEMO-10", PREPAY)).toThrow();
    expect(() => req("DEMO-1", { ...PREPAY, prepaidCents: null })).toThrow(
      /amount/,
    );
  });

  it("keeps state in a cookie and starts over from a tampered one", () => {
    const store = seedDemoStore(T0);
    expect(decodeDemoStore(encodeDemoStore(store), T0 + 5)).toEqual({
      store,
      fresh: false,
    });
    const bad = Buffer.from(
      JSON.stringify({
        ...store,
        sales: [{ ...store.sales[0], sale: "pre-1-0-x" }],
      }),
    ).toString("base64url");
    expect(decodeDemoStore(bad, T0).fresh).toBe(true);
    expect(decodeDemoStore("not base64 json", T0).fresh).toBe(true);
    expect(encodeDemoStore(store).length).toBeLessThan(3000);
  });
});
