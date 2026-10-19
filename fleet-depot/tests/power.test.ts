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
});
