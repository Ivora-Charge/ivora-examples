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

// A literal "$" right before a template interpolation, and a "($)" label.
const DOLLAR_BEFORE_INTERPOLATION = /\$\$\{/;
const DOLLAR_LABEL = /\(\$\)/;

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
      expect(code).not.toMatch(DOLLAR_BEFORE_INTERPOLATION);
      expect(code).not.toMatch(DOLLAR_LABEL);
    });
  }
});

// .ts modules that build text a person reads: the receipt email and the
// cashier's sale messages. Their arithmetic (store.ts stops prepaid sales in
// hundredths of a cent) is not display, so only the text patterns apply.
describe("display text in .ts modules", () => {
  for (const rel of ["lib/receipt-email.ts", "lib/store.ts"]) {
    const code = readFileSync(path.join(root, rel), "utf8");
    it(`${rel} has no hard-coded currency in its messages`, () => {
      expect(code).not.toMatch(/USD/);
      expect(code).not.toMatch(/(^|[^$\\])\$\s?\d/m);
      expect(code).not.toMatch(DOLLAR_BEFORE_INTERPOLATION);
      expect(code).not.toMatch(DOLLAR_LABEL);
      expect(code).not.toMatch(/\$\{[^}]*\}\s*cents\b/);
      expect(code).not.toMatch(/formatMoney\([^,()]*\)/);
    });
  }
});
