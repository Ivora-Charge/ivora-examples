import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { boardState, type Depot } from "@/lib/depot";
import { DEMO_TZ, demoState, nightEndOf } from "@/lib/demo";
import {
  anchorCookie,
  depotFor,
  dropDemoDepots,
  freshAnchor,
  readAnchor,
  simTime,
  type Anchor,
} from "@/lib/demo-visitor";

const MIN = 60_000;

/** What a visitor sees, without the random IDs of log lines. */
async function board(d: Depot) {
  const s = await boardState(d);
  return {
    now: s.now,
    totalKw: s.totalKw,
    rows: s.rows.map((r) => ({
      id: r.vehicle.id,
      departure: r.vehicle.departure,
      kw: r.session?.allocatedKw,
      kwh: r.session?.deliveredKwh,
      remaining: r.remainingKwh,
    })),
    events: s.events.map((e) => [e.at, e.type, e.detail]),
    samples: demoState(d)!.samples,
    outcomes: demoState(d)!.outcomes,
  };
}

const cookieOf = (a: Anchor) => anchorCookie(a).split(";")[0];

describe("per-visitor demo clock", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}")),
  );
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    dropDemoDepots();
  });

  const t0 = Date.UTC(2026, 9, 22, 15, 0, 0);

  it("starts a fresh night at 16:30 depot time (UTC), paused", () => {
    const a = freshAnchor(t0);
    expect(DEMO_TZ).toBe("UTC");
    expect(new Date(a.simAt).toISOString()).toBe("2026-10-22T16:30:00.000Z");
    expect(a.speed).toBe(0);
    expect(simTime(a, t0 + 3_600_000)).toBe(a.simAt);
  });

  it("runs the clock from the anchor and stops at the end of the night", () => {
    const a: Anchor = { ...freshAnchor(t0), speed: 300 };
    expect(simTime(a, t0 + 60_000)).toBe(a.simAt + 300 * MIN);
    // 16:30 to 08:30 at 300x takes 3.2 minutes.
    expect(simTime(a, t0 + 192_000)).toBe(nightEndOf(a.base));
    expect(simTime(a, t0 + 3_600_000)).toBe(nightEndOf(a.base));
  });

  it("reads back only the anchors it wrote", () => {
    const a = freshAnchor(t0);
    expect(readAnchor(`x=1; ${cookieOf(a)}`, t0)).toEqual(a);
    expect(readAnchor(null, t0)).toBeUndefined();
    expect(readAnchor("depot_demo=garbage", t0)).toBeUndefined();
    const far = { ...a, speed: 7 };
    expect(readAnchor(cookieOf(far as never), t0)).toBeUndefined();
  });

  it("gives two fresh instances with the same cookie the same board", async () => {
    const a: Anchor = { ...freshAnchor(t0), speed: 60 };
    // One instance follows the night with irregular polls...
    const now = t0 + 7.3 * 60_000; // 7.3 real minutes at 60x: about 23:48
    for (let t = t0; t < now; t += 13_337) await depotFor(a, t);
    const first = await board(await depotFor(a, now));
    // ...another one, fresh, gets the same cookie once and replays.
    vi.resetModules();
    const fresh = await import("@/lib/demo-visitor");
    const depot = await import("@/lib/depot");
    fresh.dropDemoDepots();
    const d2 = await fresh.depotFor(fresh.readAnchor(cookieOf(a), now)!, now);
    const s2 = await depot.boardState(d2);
    expect(s2.now).toBe(first.now);
    expect(s2.totalKw).toBeCloseTo(first.totalKw, 6);
    expect(s2.rows.map((r) => [r.vehicle.id, r.session?.deliveredKwh])).toEqual(
      first.rows.map((r) => [r.id, r.kwh]),
    );
    expect(s2.events.map((e) => [e.at, e.type, e.detail])).toEqual(
      first.events,
    );
  });

  it("replays to the same board however the clock got there", async () => {
    const a: Anchor = { ...freshAnchor(t0), speed: 300 };
    const end = t0 + 200_000;
    for (let t = t0; t < end; t += 2_500) await depotFor(a, t);
    const played = await board(await depotFor(a, end));
    dropDemoDepots();
    const replayed = await board(await depotFor(a, end));
    expect(replayed).toEqual(played);
    expect(Object.values(played.outcomes).every((o) => o.ready)).toBe(true);
    expect(Object.keys(played.outcomes)).toHaveLength(12);
  });

  it("keeps visitors apart: one visitor's clock does not move another's", async () => {
    const a = freshAnchor(t0);
    const b: Anchor = { ...freshAnchor(t0), speed: 300 };
    await depotFor(b, t0 + 120_000);
    const da = await depotFor(a, t0 + 120_000);
    expect(new Date((await boardState(da)).now).toISOString()).toBe(
      "2026-10-22T16:30:00.000Z",
    );
    // Reset for b is a new anchor: a new depot, back at 16:30.
    const b2 = freshAnchor(t0 + 130_000);
    expect(b2.id).not.toBe(b.id);
    const db2 = await depotFor(b2, t0 + 130_000);
    expect((await boardState(db2)).rows.every((r) => !r.session)).toBe(true);
    expect(da).not.toBe(db2);
  });
});
