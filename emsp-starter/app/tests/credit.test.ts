import { describe, expect, it } from "vitest";
import { clearOfCredit, type Box } from "../src/lib/credit";

// A phone's credit strip, and a cluster's 66 px box with its top left corner at x, y.
const credit: Box = { left: 24, right: 386, top: 311, bottom: 328 };
const at = (x: number, y: number): Box => ({
  left: x,
  right: x + 66,
  top: y,
  bottom: y + 66,
});

describe("a marker and the map credit", () => {
  it("leaves a marker that does not meet it where it is", () => {
    expect(clearOfCredit(at(170, 175), credit)).toBe(0);
    // Touching an edge is not covering.
    expect(clearOfCredit(at(170, 245), credit)).toBe(0);
    expect(clearOfCredit(at(170, 328), credit)).toBe(0);
    expect(clearOfCredit(at(-42, 300), credit)).toBe(0);
    expect(clearOfCredit(at(386, 300), credit)).toBe(0);
  });

  it("lifts one centred above the credit's middle to end at its top", () => {
    expect(clearOfCredit(at(170, 250), credit)).toBe(5);
    expect(clearOfCredit(at(170, 286), credit)).toBe(41);
    // Whole pixels, rounded away from the credit.
    expect(clearOfCredit(at(170, 250.4), credit)).toBe(6);
  });

  it("does not draw one centred at the credit's middle or lower", () => {
    expect(clearOfCredit(at(170, 286.5), credit)).toBe("hide");
    expect(clearOfCredit(at(-6, 314), credit)).toBe("hide");
  });
});
