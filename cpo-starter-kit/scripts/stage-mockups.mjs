// Copies the SQD-80 design mockups (docs/mockups) into public/mockups so a Vercel PREVIEW
// deployment serves them at /mockups/. It does nothing on production or on a normal
// build: the mockups are never part of the shipped app.
//   VERCEL_ENV=preview node scripts/stage-mockups.mjs     (or MOCKUPS=1 to try locally)
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const on = process.env.VERCEL_ENV === "preview" || process.env.MOCKUPS === "1";
const out = new URL("../public/mockups/", import.meta.url);
if (!on) {
  console.log("stage-mockups: not a preview build, skipping");
  process.exit(0);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL("docs/", out), { recursive: true });
const src = (p) => new URL(`../${p}`, import.meta.url);
cpSync(src("docs/mockups"), new URL("docs/mockups", out), { recursive: true });
cpSync(src("docs/screens"), new URL("docs/screens", out), { recursive: true });
mkdirSync(new URL("brand/", out), { recursive: true });
cpSync(src("brand/tokens.css"), new URL("brand/tokens.css", out));
cpSync(src("brand/fonts"), new URL("brand/fonts", out), { recursive: true });
writeFileSync(
  new URL("index.html", out),
  '<!doctype html><meta charset="utf-8"><title>Ampleaf mockups</title><meta http-equiv="refresh" content="0; url=docs/mockups/index.html"><a href="docs/mockups/index.html">Ampleaf polish mockups</a>\n',
);
console.log("stage-mockups: staged public/mockups/ for this preview");
