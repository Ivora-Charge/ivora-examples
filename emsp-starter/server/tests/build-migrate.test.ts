import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMigrationPlan,
  runBuildMigrations,
  SWITCH,
} from "../scripts/build-migrate.mjs";
import {
  applyPending,
  MigrationError,
  MIGRATIONS_DIRECTORY,
} from "../scripts/migrate.mjs";
import { SUPABASE_STUB } from "./support/pglite";

// No test here connects to a real database: the runner's SQL goes to PGlite, and the
// build step's connection is a stub.

const PASSWORD = "pw-never-in-logs";
const URL_VALUE = `postgres://postgres:${PASSWORD}@db.example.test:5432/postgres`;
const PRODUCTION = { VERCEL: "1", VERCEL_ENV: "production" };

describe("which builds migrate", () => {
  it("a Vercel production build with a connection string", () => {
    for (const name of [
      "SUPABASE_DB_URL",
      "POSTGRES_URL_NON_POOLING",
      "POSTGRES_URL",
    ]) {
      const plan = buildMigrationPlan({ ...PRODUCTION, [name]: URL_VALUE });
      expect(plan.run).toBe(true);
      expect(plan.database?.name).toBe(name);
    }
  });

  it("SUPABASE_DB_URL wins over the integration's names, as in db:migrate", () => {
    const plan = buildMigrationPlan({
      ...PRODUCTION,
      POSTGRES_URL: "postgres://pooled",
      POSTGRES_URL_NON_POOLING: "postgres://direct",
      SUPABASE_DB_URL: "postgres://own",
    });
    expect(plan.database).toEqual({
      name: "SUPABASE_DB_URL",
      url: "postgres://own",
    });
  });

  it.each(["preview", "development"])(
    "never a Vercel %s build, even with the switch on",
    (vercelEnv) => {
      for (const choice of [undefined, "on", "true"]) {
        const plan = buildMigrationPlan({
          VERCEL: "1",
          VERCEL_ENV: vercelEnv,
          [SWITCH]: choice,
          POSTGRES_URL_NON_POOLING: URL_VALUE,
        });
        expect(plan).toEqual({ run: false, reason: expect.any(String) });
        expect(plan.reason).toContain(vercelEnv);
      }
    },
  );

  it("never on Vercel without VERCEL_ENV (system variables off)", () => {
    const plan = buildMigrationPlan({
      VERCEL: "1",
      [SWITCH]: "on",
      POSTGRES_URL_NON_POOLING: URL_VALUE,
    });
    expect(plan.run).toBe(false);
    expect(plan.reason).toContain("VERCEL_ENV");
  });

  it("never a local or CI build unless the switch is on", () => {
    for (const env of [
      { SUPABASE_DB_URL: URL_VALUE },
      { SUPABASE_DB_URL: URL_VALUE, NODE_ENV: "production", CI: "true" },
    ]) {
      const plan = buildMigrationPlan(env);
      expect(plan.run).toBe(false);
      expect(plan.reason).toContain(SWITCH);
    }
  });

  it("a build off Vercel when the switch is on", () => {
    for (const choice of ["on", "true", "1", "YES"]) {
      const plan = buildMigrationPlan({
        [SWITCH]: choice,
        SUPABASE_DB_URL: URL_VALUE,
      });
      expect(plan.run).toBe(true);
    }
  });

  it("no build when the switch is off (migrations from CI)", () => {
    for (const choice of ["off", "false", "0", "No"]) {
      const plan = buildMigrationPlan({
        ...PRODUCTION,
        [SWITCH]: choice,
        POSTGRES_URL_NON_POOLING: URL_VALUE,
      });
      expect(plan).toEqual({ run: false, reason: `${SWITCH} is off.` });
    }
  });

  it("fails on a switch value it does not know, without echoing it", () => {
    const plan = buildMigrationPlan({
      ...PRODUCTION,
      [SWITCH]: "maybe-later",
      POSTGRES_URL_NON_POOLING: URL_VALUE,
    });
    expect(plan.run).toBe(false);
    expect(plan.error).toContain(SWITCH);
    expect(plan.error).not.toContain("maybe-later");
  });

  it("no build in forced demo mode", () => {
    const plan = buildMigrationPlan({
      ...PRODUCTION,
      DEMO_MODE: "true",
      POSTGRES_URL_NON_POOLING: URL_VALUE,
    });
    expect(plan).toEqual({ run: false, reason: "DEMO_MODE is on." });
  });

  it("passes without a connection string (empty or demo counts as unset)", () => {
    for (const env of [
      PRODUCTION,
      { ...PRODUCTION, SUPABASE_DB_URL: "", POSTGRES_URL: "demo" },
    ]) {
      const plan = buildMigrationPlan(env);
      expect(plan.run).toBe(false);
      expect(plan.reason).toContain("no connection string");
    }
  });
});

describe("the build step", () => {
  const output = () => {
    const lines: string[] = [];
    const push = (...args: unknown[]) => lines.push(args.join(" "));
    return { lines, log: push, error: push };
  };

  it("invokes the runner once on a production build", async () => {
    const apply = vi.fn(async () => ["202611250001_hub_push_switch.sql"]);
    const out = output();
    const code = await runBuildMigrations(
      { ...PRODUCTION, POSTGRES_URL_NON_POOLING: URL_VALUE },
      { apply, ...out },
    );
    expect(code).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      { name: "POSTGRES_URL_NON_POOLING", url: URL_VALUE },
      expect.anything(),
    );
    expect(out.lines.join("\n")).not.toContain(PASSWORD);
  });

  it("skips the runner on a preview build and on a build without a URL", async () => {
    for (const env of [
      {
        VERCEL: "1",
        VERCEL_ENV: "preview",
        POSTGRES_URL_NON_POOLING: URL_VALUE,
      },
      PRODUCTION,
      { SUPABASE_DB_URL: URL_VALUE },
    ]) {
      const apply = vi.fn();
      const out = output();
      expect(await runBuildMigrations(env, { apply, ...out })).toBe(0);
      expect(apply).not.toHaveBeenCalled();
      expect(out.lines.join("\n")).toMatch(/^Build-time migrations skipped: /);
      expect(out.lines.join("\n")).not.toContain(PASSWORD);
    }
  });

  it("fails the build with the file name, never the connection string", async () => {
    const apply = vi.fn(async () => {
      throw new MigrationError("202611250001_hub_push_switch.sql", "42P07");
    });
    const out = output();
    const code = await runBuildMigrations(
      { ...PRODUCTION, SUPABASE_DB_URL: URL_VALUE },
      { apply, ...out },
    );
    expect(code).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toContain(
      "Migration failed in 202611250001_hub_push_switch.sql: 42P07.",
    );
    expect(text).toContain("previous deployment stays live");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("db.example.test");
  });

  it("does not repeat another error's message, which may hold the URL", async () => {
    const apply = vi.fn(async () => {
      throw new Error(`could not connect to ${URL_VALUE}`);
    });
    const out = output();
    const code = await runBuildMigrations(
      { ...PRODUCTION, SUPABASE_DB_URL: URL_VALUE },
      { apply, ...out },
    );
    expect(code).toBe(1);
    expect(out.lines.join("\n")).toContain(
      "Migration failed: connection error.",
    );
    expect(out.lines.join("\n")).not.toContain(PASSWORD);
  });

  it("fails the build on an unknown switch value", async () => {
    const apply = vi.fn();
    const out = output();
    const code = await runBuildMigrations(
      { ...PRODUCTION, [SWITCH]: "sometimes", SUPABASE_DB_URL: URL_VALUE },
      { apply, ...out },
    );
    expect(code).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("the build scripts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  it.each(["build", "build:one-domain"])(
    "%s migrates after next build",
    (name) => {
      expect(pkg.scripts[name]).toMatch(
        /&& next build && node scripts\/build-migrate\.mjs$/,
      );
    },
  );

  // The script as `npm run build` runs it, in a clean environment.
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/build-migrate.mjs"], {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...env },
      encoding: "utf8",
    });

  it("passes on a production build without a connection string", () => {
    const result = run(PRODUCTION);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Build-time migrations skipped: no connection string",
    );
  });

  it("passes on a preview build that has a connection string, without connecting", () => {
    const result = run({
      VERCEL: "1",
      VERCEL_ENV: "preview",
      POSTGRES_URL_NON_POOLING: URL_VALUE,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Build-time migrations skipped");
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
  });

  it("passes on a local build that has a connection string, without connecting", () => {
    const result = run({ SUPABASE_DB_URL: URL_VALUE });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${SWITCH} is not on`);
  });
});

/** The part of a postgres.js client the runner uses, over PGlite. */
function pgliteClient(db: PGlite) {
  const wrap = (tx: Transaction) => {
    const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((acc, part, i) => acc + `$${i}` + part);
      return (await tx.query(text, values)).rows;
    };
    return Object.assign(tag, { unsafe: (sql: string) => tx.exec(sql) });
  };
  return {
    begin: <T>(fn: (tx: ReturnType<typeof wrap>) => Promise<T>) =>
      db.transaction((tx) => fn(wrap(tx))),
  };
}

describe("the runner (applyPending) on PGlite", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const ledger = async (db: PGlite) =>
    (
      await db.query<{ filename: string }>(
        "select filename from public.emsp_schema_migrations order by 1",
      )
    ).rows.map((r) => r.filename);

  it("applies every shipped file once, then nothing", async () => {
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    const shipped = (await readdir(MIGRATIONS_DIRECTORY)).filter((f) =>
      f.endsWith(".sql"),
    );
    const first = await applyPending(pgliteClient(db), MIGRATIONS_DIRECTORY);
    expect(first).toEqual([...shipped].sort());
    expect(await ledger(db)).toEqual([...shipped].sort());
    expect(await applyPending(pgliteClient(db), MIGRATIONS_DIRECTORY)).toEqual(
      [],
    );
    await db.close();
  }, 60_000);

  it("names the failing file and applies none of the batch", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "emsp-migrations-"));
    const shipped = (await readdir(MIGRATIONS_DIRECTORY))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of shipped.slice(0, 2))
      await copyFile(new URL(f, MIGRATIONS_DIRECTORY), path.join(dir, f));
    const bad = "209912310001_broken.sql";
    await writeFile(
      path.join(dir, bad),
      "begin;\ninsert into public.no_such_table values ('row-value-secret');\ncommit;\n",
    );
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    const directory = pathToFileURL(dir + path.sep);
    const error = await applyPending(pgliteClient(db), directory).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).file).toBe(bad);
    expect((error as MigrationError).message).toBe(
      `Migration failed in ${bad}: 42P01.`,
    );
    expect((error as MigrationError).message).not.toContain("row-value-secret");
    // One transaction: the files before it are not applied either, nor the ledger.
    const { rows } = await db.query(
      "select to_regclass('public.emsp_schema_migrations') as t",
    );
    expect(rows).toEqual([{ t: null }]);
    await db.close();
  }, 60_000);
});
