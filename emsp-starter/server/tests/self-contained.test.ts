import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("self-contained folder", () => {
  it("runs the migration checker from inside the folder", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    for (const script of Object.values<string>(pkg.scripts))
      expect(script).not.toMatch(/\.\.\//);
    expect(pkg.scripts["check:migrations"]).toContain(
      "scripts/check-migrations/",
    );
  });

  it("db:migrate does not require .env.local to exist", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["db:migrate"]).toContain("--env-file-if-exists=");
  });
});
