import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Display code reads the currency from the API response: no "$", "USD",
// "/ 100" or fixed two-decimal formatting, and every formatMoney call names
// its currency.

const root = path.resolve(import.meta.dirname, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : /\.tsx$/.test(name)
        ? [full]
        : [];
  });

describe("display components", () => {
  for (const file of files(root)) {
    const rel = path.relative(root, file);
    const code = readFileSync(file, "utf8");
    it(`${rel} has no hard-coded currency`, () => {
      expect(code).not.toMatch(/USD/);
      expect(code).not.toMatch(/\/\s*100\b/);
      expect(code).not.toMatch(/toFixed\(2\)/);
      // A literal dollar sign before a digit or a JSX expression.
      expect(code).not.toMatch(/(^|[^$\\])\$\s?\d/m);
      expect(code).not.toMatch(/formatMoney\([^,()]*\)/);
    });
  }
});
