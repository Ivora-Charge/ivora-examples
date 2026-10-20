import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeDemoId,
  DEMO_SPEED,
  DEMO_START_DELAY_MS,
  demoCurve,
  demoView,
  encodeDemoId,
  startDemoSession,
  stopDemoSession,
  unplugDemoSession,
} from "@/lib/demo";
import {
  chargerFor,
  pay,
  sessionView,
  stop,
  unplug,
} from "@/lib/server/driver";
import { readSettings } from "@/lib/settings";

const T0 = Date.parse("2026-10-19T12:00:00Z");
const settings = { idleGraceMinutes: 10, applicationFeeBps: 1000 };
const charging = T0 + DEMO_START_DELAY_MS;
/** Real time at which `simSeconds` of simulated charging have passed. */
const sim = (simSeconds: number) => charging + (simSeconds / DEMO_SPEED) * 1000;
const fullAt = demoCurve(150_000, 0).fullAtSim;

describe("demo session IDs carry their own state", () => {
  it("round-trips and rejects anything else", () => {
    const id = encodeDemoId({
      code: "DEMO-1",
      connector: 1,
      start: T0,
      stop: null,
      unplug: T0 + 5000,
    });
    expect(decodeDemoId(id)).toEqual({
      code: "DEMO-1",
      connector: 1,
      start: T0,
      stop: null,
      unplug: T0 + 5000,
    });
    expect(decodeDemoId("demo.DEMO-1.1")).toBeNull();
    expect(decodeDemoId("demo.<script>.1.abc")).toBeNull();
    expect(decodeDemoId("cs_test_123")).toBeNull();
  });

  it("refuses busy or faulted demo connectors", () => {
    expect(() => startDemoSession("DEMO-2", 1, T0)).toThrow(/charging/);
    expect(() => startDemoSession("DEMO-2", 2, T0)).toThrow(/faulted/);
    expect(() => startDemoSession("NOPE", 1, T0)).toThrow();
  });
});

describe("demo timeline: scan to receipt", () => {
  const id = startDemoSession("DEMO-1", 1, T0);

  it("starts, charges with live kWh, power and running cost", () => {
    expect(demoView(id, T0 + 1000, settings)!.phase).toBe("starting");
    const v = demoView(id, sim(600), settings)!;
    expect(v.phase).toBe("charging");
    expect(v.powerW).toBe(150_000);
    expect(v.energyWh).toBe(25_000); // 150 kW for 10 min
    // 25 kWh x 45c + 10 min x 6c + $1 session fee
    expect(v.runningCents).toBe(1125 + 60 + 100);
  });

  it("counts down the idle grace when the car is full, then accrues the fee", () => {
    const v = demoView(id, sim(fullAt + 60), settings)!;
    expect(v.phase).toBe("finished");
    expect(v.idle).toMatchObject({ secondsUntilFee: 540, accruing: false });
    const later = demoView(id, sim(fullAt + 12 * 60), settings)!;
    expect(later.idle).toMatchObject({ accruing: true, accruedCents: 80 }); // 2 min at $0.40
  });

  it("prices the receipt with the idle grace waived and the fee in basis points", () => {
    const unplugged = unplugDemoSession(id, sim(fullAt + 18 * 60));
    const v = demoView(unplugged, sim(fullAt + 30 * 60), settings)!;
    expect(v.phase).toBe("completed");
    const s = v.receipt!.settlement;
    const idle = v.receipt!.rows.find((r) => r.label === "Idle fee")!;
    expect(idle.amountCents).toBe(720); // 18 min at $24/h
    expect(s.graceCreditCents).toBe(400); // first 10 min free
    expect(s.chargedCents).toBe(s.billTotalCents - 400);
    expect(s.releasedCents).toBe(5000 - s.chargedCents);
    expect(s.applicationFeeCents).toBe(
      Math.floor((s.chargedCents * 1000 + 5000) / 10000),
    );
    // The receipt is frozen at the unplug, however late it is read.
    expect(
      demoView(unplugged, sim(fullAt + 90 * 60), settings)!.receipt,
    ).toEqual(v.receipt);
  });

  it("charges no idle fee when the car leaves within the grace period", () => {
    const unplugged = unplugDemoSession(id, sim(fullAt + 30)); // 30 s idle
    const r = demoView(unplugged, sim(fullAt + 60), settings)!.receipt!;
    const idle = r.rows.find((row) => row.label === "Idle fee")!;
    expect(idle.amountCents).toBe(40); // billed as one started minute
    expect(r.settlement.graceCreditCents).toBe(40); // and waived in full
  });

  it("ends without idle time when the driver presses stop", () => {
    const stopped = stopDemoSession(id, sim(300));
    const v = demoView(stopped, sim(400), settings)!;
    expect(v.phase).toBe("completed");
    expect(v.receipt!.idleSeconds).toBe(0);
    expect(v.message).toMatch(/move your car/);
    expect(stopDemoSession(stopped, sim(500))).toBe(stopped); // stop is idempotent
  });

  it("cancels with no charge when stopped before charging starts", () => {
    const v = demoView(stopDemoSession(id, T0 + 500), T0 + 1000, settings)!;
    expect(v.phase).toBe("canceled");
    expect(v.receipt).toBeNull();
  });
});

describe("demo end to end through the driver entry points", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("Demo mode must not make network requests.");
  });
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("runs scan, pay, charge, idle, unplug and receipt with no payment or charger calls", async () => {
    // No credentials at all: demo mode.
    const s = readSettings({});
    expect(s.demo).toBe(true);
    const page = await chargerFor("DEMO-1", 1, s);
    expect(page).toMatchObject({
      demo: true,
      holdCents: 5000,
      estimate: { totalCents: 1600 },
    });

    const { id, url } = await pay(
      {
        code: "DEMO-1",
        connector: 1,
        requestId: "8a6e0804-2bd0-4672-b79d-d97027f55c9b",
      },
      s,
      T0,
    );
    expect(url).toBe(`/s/${id}`);
    expect((await sessionView(id, s, sim(600))).phase).toBe("charging");
    expect((await sessionView(id, s, sim(fullAt + 30))).phase).toBe("finished");
    const done = await unplug(id, s, sim(fullAt + 15 * 60));
    expect(done.phase).toBe("completed");
    // The driver's view never carries the deployer's fee.
    expect(done.receipt!.settlement.applicationFeeCents).toBe(0);
    expect(
      (await sessionView(done.id, s, sim(fullAt + 20 * 60))).receipt,
    ).toEqual(done.receipt);

    const second = await pay(
      {
        code: "DEMO-1",
        connector: 2,
        requestId: "0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d",
      },
      s,
      T0,
    );
    expect((await stop(second.id, s, T0 + 20_000)).phase).toBe("completed");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses live session IDs in demo mode instead of calling Stripe", async () => {
    await expect(
      sessionView("cs_test_a1B2c3D4e5F6g7H8", readSettings({})),
    ).rejects.toMatchObject({ code: "session_not_found" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
