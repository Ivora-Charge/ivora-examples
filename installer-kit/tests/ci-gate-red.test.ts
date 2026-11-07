import { expect, test } from "vitest";

// Temporary: proves ci-gate fails when a template job fails. Reverted in the next commit.
test("ci-gate red check", () => {
  expect(1).toBe(2);
});
