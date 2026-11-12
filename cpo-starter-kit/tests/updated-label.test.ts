import { describe, expect, it } from "vitest";
import { updatedLabel } from "@/lib/updated-label";

describe("updatedLabel", () => {
  const at = "2026-11-11T19:03:22.000Z";

  it("shows the company time zone first and UTC second", () => {
    expect(updatedLabel(at, "America/New_York")).toBe(
      "14:03:22 EST (19:03:22 UTC)",
    );
  });

  it("shows UTC alone without a zone, for UTC, or for an unknown zone", () => {
    expect(updatedLabel(at, null)).toBe("19:03:22 UTC");
    expect(updatedLabel(at, "UTC")).toBe("19:03:22 UTC");
    expect(updatedLabel(at, "Not/AZone")).toBe("19:03:22 UTC");
  });
});
