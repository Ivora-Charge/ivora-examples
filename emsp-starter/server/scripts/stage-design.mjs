// Copies the admin redesign mockups (../design/admin-redesign/*.html) into
// public/design/ so a Vercel PREVIEW deployment serves them at /design/index.html for
// review on a phone. It does nothing on a production or a normal local build: the
// mockups are never part of the shipped app, and no page, route or test uses them.
//   VERCEL_ENV=preview node scripts/stage-design.mjs     (or MOCKUPS=1 to try locally)
// Remove this script and its line in vercel.json when the design is built.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const on = process.env.VERCEL_ENV === "preview" || process.env.MOCKUPS === "1";
const from = new URL("../../design/admin-redesign/", import.meta.url);
const out = new URL("../public/design/", import.meta.url);
if (!on) {
  console.log("stage-design: not a preview build, skipping");
} else if (!existsSync(from)) {
  // A fork that deploys server/ alone has no design folder: nothing to stage.
  console.log("stage-design: no design folder here, skipping");
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pages = readdirSync(from).filter((f) => f.endsWith(".html"));
  for (const f of pages) cpSync(new URL(f, from), new URL(f, out));
  console.log(`stage-design: staged ${pages.length} pages in public/design/`);
}
