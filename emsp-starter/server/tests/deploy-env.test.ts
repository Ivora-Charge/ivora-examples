import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  config,
  configErrors,
  LIVE_REQUIRED,
  missingForLive,
  ocpiUrls,
} from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { readSetupStatus } from "@/lib/setup/status";
import { databaseUrl, DB_URL_NAMES } from "../scripts/migrate.mjs";

// What a deployment made by the Deploy button has: the names the Supabase integration
// of the Vercel Marketplace sets, and Vercel's own system variables.

const KEY = "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY";
const SECRET = "sb_secret_exampleexample";
const PUBLISHABLE = "sb_publishable_exampleexample";
/** An unsigned stand-in for a legacy Supabase key, with this role. */
const jwt = (role: string) =>
  [{ alg: "HS256", typ: "JWT" }, { iss: "supabase", role }, "signature"]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");

const PRODUCTION = "emsp.example.test";
const PREVIEW = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_URL: "emsp-abc123-team.vercel.app",
  VERCEL_BRANCH_URL: "emsp-git-feature-team.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: PRODUCTION,
};
const OTHERS = {
  EMSP_COUNTRY_CODE: "NL",
  EMSP_PARTY_ID: "ABC",
  SUPABASE_URL: "https://db.example.test",
  OCPI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const saved = { ...process.env };
beforeEach(() => {
  for (const name of [
    ...LIVE_REQUIRED,
    "SUPABASE_SECRET_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "DEMO_MODE",
    ...Object.keys(PREVIEW),
  ])
    delete process.env[name];
});
afterEach(() => {
  process.env = { ...saved };
});

describe("the server key", () => {
  beforeEach(() => {
    Object.assign(process.env, OTHERS, {
      PUBLIC_BASE_URL: `https://${PRODUCTION}`,
    });
  });

  it("is taken from SUPABASE_SECRET_KEY when ours is unset, empty or `demo`", () => {
    process.env.SUPABASE_SECRET_KEY = SECRET;
    for (const ours of [undefined, "", "demo"]) {
      if (ours !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = ours;
      expect(config.supabaseServiceRoleKey).toBe(SECRET);
      expect(missingForLive()).toEqual([]);
      expect(configErrors()).toEqual([]);
      expect(isDemo()).toBe(false);
    }
  });

  it("is our own name's when both are set", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = jwt("service_role");
    process.env.SUPABASE_SECRET_KEY = SECRET;
    expect(config.supabaseServiceRoleKey).toBe(jwt("service_role"));
    expect(configErrors()).toEqual([]);
  });

  it("is missing, under both names, when neither is set", () => {
    expect(config.supabaseServiceRoleKey).toBe("");
    expect(missingForLive()).toEqual([KEY]);
    expect(isDemo()).toBe(true);
  });

  it("is never taken from a publishable or anon key's variable", () => {
    Object.assign(process.env, {
      SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      SUPABASE_ANON_KEY: jwt("anon"),
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("anon"),
    });
    expect(config.supabaseServiceRoleKey).toBe("");
    expect(missingForLive()).toEqual([KEY]);
  });

  it.each(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"])(
    "refuses a publishable or anon key in %s, naming it and not its value",
    (name) => {
      for (const key of [PUBLISHABLE, jwt("anon"), jwt("authenticated")]) {
        process.env[name] = key;
        expect(config.supabaseServiceRoleKey).toBe("");
        expect(missingForLive()).toEqual([]);
        expect(configErrors()).toEqual([
          `${name} must be a secret key (sb_secret_) or the legacy service_role key, never a publishable or anon key`,
        ]);
        expect(isDemo()).toBe(true);
      }
    },
  );

  it("does not pass over a wrong key under our name for the other one", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = PUBLISHABLE;
    process.env.SUPABASE_SECRET_KEY = SECRET;
    expect(config.supabaseServiceRoleKey).toBe("");
    expect(configErrors()).toHaveLength(1);
    expect(configErrors()[0]).toMatch(/^SUPABASE_SERVICE_ROLE_KEY /);
  });

  it("counts on Setup as one live-mode setting, whichever name is wrong or missing", async () => {
    // Demo mode: the status read asks no database.
    const deps = {
      accounts: { countAdmins: async () => 0 },
      peers: { listPeers: async () => [] },
      payments: {
        lastEvent: async () => null,
        lastSweptAt: async () => null,
      },
      database: async () => {
        throw new Error("not asked in demo mode");
      },
    } as unknown as Parameters<typeof readSetupStatus>[0];
    process.env.SUPABASE_SECRET_KEY = PUBLISHABLE;
    expect((await readSetupStatus(deps)).environment).toMatchObject({
      required: LIVE_REQUIRED.length,
      missing: [],
      malformedRequired: 1,
    });
    delete process.env.SUPABASE_SECRET_KEY;
    expect((await readSetupStatus(deps)).environment).toMatchObject({
      missing: [KEY],
      malformed: [],
      malformedRequired: 0,
    });
  });
});

describe("this server's address on Vercel", () => {
  beforeEach(() => {
    Object.assign(process.env, OTHERS, { SUPABASE_SECRET_KEY: SECRET });
  });

  it.each(["production", "preview"])(
    "is the project's production domain in a %s deployment, never the deployment's own",
    (target) => {
      Object.assign(process.env, PREVIEW, { VERCEL_ENV: target });
      expect(config.publicBaseUrl).toBe(`https://${PRODUCTION}`);
      expect(missingForLive()).toEqual([]);
      expect(configErrors()).toEqual([]);
      expect(isDemo()).toBe(false);
      for (const url of Object.values(ocpiUrls()))
        expect(url.startsWith(`https://${PRODUCTION}/ocpi/`)).toBe(true);
    },
  );

  it("is missing, not the preview's, without a usable production domain", () => {
    Object.assign(process.env, PREVIEW);
    for (const value of [
      undefined,
      "",
      "demo",
      `https://${PRODUCTION}`,
      `${PRODUCTION}/path`,
      `${PRODUCTION}?q=1`,
      `user@${PRODUCTION}`,
      "not a host",
    ]) {
      if (value === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      else process.env.VERCEL_PROJECT_PRODUCTION_URL = value;
      expect(config.publicBaseUrl, value).toBe("http://localhost:3000");
      expect(missingForLive(), value).toEqual(["PUBLIC_BASE_URL"]);
      expect(isDemo()).toBe(true);
    }
  });

  it("is PUBLIC_BASE_URL whenever that is set", () => {
    Object.assign(process.env, PREVIEW, {
      PUBLIC_BASE_URL: "https://charge.example.org/",
    });
    expect(config.publicBaseUrl).toBe("https://charge.example.org");
    expect(ocpiUrls().versions).toBe(
      "https://charge.example.org/ocpi/versions",
    );
    // A wrong explicit value is reported, not replaced.
    process.env.PUBLIC_BASE_URL = "http://charge.example.org";
    expect(config.publicBaseUrl).toBe("http://charge.example.org");
    expect(configErrors()).toEqual([
      "PUBLIC_BASE_URL must be an https:// origin",
    ]);
  });

  it("is derived on Vercel only, and not in local development", () => {
    for (const [vercel, target] of [
      [undefined, "production"],
      ["1", "development"],
    ]) {
      Object.assign(process.env, PREVIEW, { VERCEL_ENV: target });
      if (vercel === undefined) delete process.env.VERCEL;
      expect(config.publicBaseUrl).toBe("http://localhost:3000");
      expect(missingForLive()).toEqual(["PUBLIC_BASE_URL"]);
    }
  });
});

describe("db:migrate's connection string", () => {
  const url = (user: string) =>
    `postgres://${user}:p%40ss@db.example.test:5432/postgres?sslmode=require`;
  const ALL = {
    SUPABASE_DB_URL: url("ours"),
    POSTGRES_URL_NON_POOLING: url("direct"),
    POSTGRES_URL: url("pooled"),
  };

  it("is SUPABASE_DB_URL, then POSTGRES_URL_NON_POOLING, then POSTGRES_URL", () => {
    expect(DB_URL_NAMES).toEqual(Object.keys(ALL));
    const env: Record<string, string> = { ...ALL };
    for (const name of DB_URL_NAMES) {
      expect(databaseUrl(env)).toEqual({
        name,
        url: ALL[name as keyof typeof ALL],
      });
      // `demo` and an empty value count as unset.
      env[name] = name === "SUPABASE_DB_URL" ? "demo" : " ";
    }
    expect(databaseUrl(env)).toBeUndefined();
    expect(databaseUrl({})).toBeUndefined();
  });

  it("leaves out the pooler's parameters, which the driver would send to Postgres", async () => {
    const base = "postgres://u:p%40ss@db.example.test:6543/postgres";
    for (const [query, kept] of [
      ["?sslmode=require&supa=base-pooler.x", "?sslmode=require"],
      ["?supa=base-pooler.x&sslmode=require", "?sslmode=require"],
      ["?pgbouncer=true&supa=x", ""],
      ["?supa=x", ""],
      ["", ""],
    ])
      expect(databaseUrl({ POSTGRES_URL: base + query })?.url).toBe(
        base + kept,
      );
    // As the driver reads it. Nothing connects until a query is made.
    const sql = postgres(
      databaseUrl({
        POSTGRES_URL: `${base}?sslmode=require&supa=base-pooler.x`,
      })!.url,
    );
    expect(Object.keys(sql.options.connection)).toEqual(["application_name"]);
    await sql.end();
  });
});
