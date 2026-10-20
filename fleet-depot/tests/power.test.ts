import { describe, expect, it } from "vitest";
import { splitPower } from "@/lib/power";

describe("splitPower", () => {
  it("gives everyone what they want under the cap", () => {
    const m = splitPower(60, [
      { id: "a", departureMs: 2, wantedKw: 11 },
      { id: "b", departureMs: 1, wantedKw: 22 },
    ]);
    expect([m.get("a"), m.get("b")]).toEqual([11, 22]);
  });
  it("serves earlier departures first when capped", () => {
    const m = splitPower(20, [
      { id: "late", departureMs: 9, wantedKw: 11 },
      { id: "early", departureMs: 1, wantedKw: 11 },
      { id: "mid", departureMs: 5, wantedKw: 11 },
    ]);
    expect(m.get("early")).toBe(11);
    expect(m.get("mid")).toBe(9);
    expect(m.get("late")).toBe(0);
  });
  it("never exceeds the cap and handles no sessions", () => {
    const m = splitPower(10, [{ id: "a", departureMs: 1, wantedKw: 50 }]);
    expect(m.get("a")).toBe(10);
    expect(splitPower(10, []).size).toBe(0);
  });
  it("is deterministic on equal departures", () => {
    const m = splitPower(5, [
      { id: "b", departureMs: 1, wantedKw: 5 },
      { id: "a", departureMs: 1, wantedKw: 5 },
    ]);
    expect(m.get("a")).toBe(5);
    expect(m.get("b")).toBe(0);
  });
  it("rounds allocations down to whole watts so the sum never overshoots", () => {
    const m = splitPower(10, [
      { id: "a", departureMs: 1, wantedKw: 3.3333333 },
      { id: "b", departureMs: 2, wantedKw: 3.3333333 },
      { id: "c", departureMs: 3, wantedKw: 3.3333333 },
      { id: "d", departureMs: 4, wantedKw: 3.3333333 },
    ]);
    expect([...m.values()]).toEqual([3.333, 3.333, 3.333, 0.001]);
    const w = [...m.values()].reduce((a, x) => a + Math.round(x * 1000), 0);
    expect(w).toBe(10000);
  });
});
