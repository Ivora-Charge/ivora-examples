import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The template folder: everything a fork of it gets. */
const ROOT = path.resolve(__dirname, "..");

// A fork of this one folder must install, check and build on its own, so no import,
// script or file path in it may point outside the folder.
const SKIP = new Set([
  "node_modules",
  ".next",
  ".expo",
  ".vercel",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
  "playwright-report",
]);
const CODE = /\.(?:[cm]?[jt]sx?|json)$/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name) || e.name.startsWith(".git")) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return CODE.test(e.name) && e.name !== "package-lock.json" ? [full] : [];
  });
}

const QUOTED = String.raw`["'\x60]([^"'\x60]*)["'\x60]`;
const SPECIFIER = new RegExp(
  String.raw`(?:\bfrom|\bimport|\brequire|\bmock|new URL)\s*\(?\s*` + QUOTED,
  "g",
);
const FROM_DIR = new RegExp(
  String.raw`(?:resolve|join)\(\s*(?:__dirname|import\.meta\.dirname)((?:\s*,\s*` +
    QUOTED +
    String.raw`)+)`,
  "g",
);

/** Every relative path a source file names, resolved against the file's folder. */
export function pathsIn(file: string, text: string): string[] {
  const dir = path.dirname(file);
  const out: string[] = [];
  for (const m of text.matchAll(SPECIFIER))
    if (/^\.\.?(?:\/|$)/.test(m[1])) out.push(path.resolve(dir, m[1]));
  for (const m of text.matchAll(FROM_DIR)) {
    const parts = [...m[1].matchAll(new RegExp(QUOTED, "g"))].map((p) => p[1]);
    out.push(path.resolve(dir, ...parts));
  }
  if (path.basename(file) === "package.json") {
    const scripts = Object.values<string>(JSON.parse(text).scripts ?? {});
    for (const s of scripts)
      for (const m of s.matchAll(/(?:^|[\s=])(\.\.\/\S*)/g))
        out.push(path.resolve(dir, m[1]));
  }
  if (/^tsconfig.*\.json$/.test(path.basename(file))) {
    const json = JSON.parse(text);
    const refs: unknown[] = [
      json.extends,
      ...Object.values<string[]>(json.compilerOptions?.paths ?? {}).flat(),
    ];
    for (const r of refs)
      if (typeof r === "string" && r.startsWith("."))
        out.push(path.resolve(dir, r));
  }
  return out;
}

const outside = (p: string) => {
  const rel = path.relative(ROOT, p);
  return (
    rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
  );
};

/** Paths in the folder's code that leave the folder, as `file: path`. */
export function escapes(): string[] {
  return files(ROOT).flatMap((f) =>
    pathsIn(f, readFileSync(f, "utf8"))
      .filter(outside)
      .map((p) => `${path.relative(ROOT, f)}: ${path.relative(ROOT, p)}`),
  );
}

describe("self-contained folder", () => {
  it("has no import, script or path that leaves the folder", () => {
    expect(escapes()).toEqual([]);
  });

  it("catches a path that leaves the folder", () => {
    const up = "../".repeat(4);
    const file = path.join(ROOT, "tests", "x.test.ts");
    const samples = [
      `import { a } from "${up}tools/check.mjs";`,
      `const u = new URL("${up}tools/", import.meta.url);`,
      `path.resolve(import.meta.dirname, "${up}", "tools");`,
      `vi.mock("${up}tools/check.mjs");`,
    ];
    for (const s of samples)
      expect(pathsIn(file, s).filter(outside)).toHaveLength(1);
    const pkg = path.join(ROOT, "package.json");
    const scripts = JSON.stringify({
      scripts: { c: `node ${up}tools/cli.mjs` },
    });
    expect(pathsIn(pkg, scripts).filter(outside)).toHaveLength(1);
    expect(
      pathsIn(file, `import { b } from "./local";`).filter(outside),
    ).toEqual([]);
  });
});
