// cpo-starter-kit and emsp-starter/server each keep a copy of this checker so a fork of
// one folder runs on its own. The copies must stay the same as this one.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (url) => readFileSync(new URL(url, import.meta.url), "utf8");
// The copied cli.mjs differs only in its usage line.
const usage = (text) => text.replace(/^\/\/ node \S+/m, "// node <checker>");

describe("the copies in the templates", () => {
  for (const copy of [
    "../../../cpo-starter-kit/scripts/check-migrations/",
    "../../../emsp-starter/server/scripts/check-migrations/",
  ]) {
    it(`${copy} matches check.mjs and cli.mjs`, () => {
      assert.equal(read(`${copy}check.mjs`), read("../check.mjs"));
      assert.equal(usage(read(`${copy}cli.mjs`)), usage(read("../cli.mjs")));
    });
  }
});
