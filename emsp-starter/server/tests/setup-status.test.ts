import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

// Server actions read the request's cookies (the admin session); tests set them here.
const requestCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name)
        ? { name, value: requestCookies.get(name) }
        : undefined,
  }),
  headers: async () => new Headers(),
}));

import { setupStatusAction } from "@/app/admin/setup/actions";
import * as cronRoute from "@/app/api/cron/ocpi-sync/route";
import { POST as webhookPOST } from "@/app/api/webhooks/stripe/route";
import { ADMIN_COOKIE } from "@/lib/accounts/admin-session";
import type { AuthProvider } from "@/lib/accounts/auth";
import {
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import { MemoryAccountStore } from "@/lib/accounts/store";
import { setCommandStoreForTests } from "@/lib/commands/registry";
import { MemoryCommandStore } from "@/lib/commands/store";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { MemoryLocationStore } from "@/lib/locations/store";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { SWEEP_MAX_AGE_MS } from "@/lib/payments/hold";
import { setPaymentStoreForTests } from "@/lib/payments/registry";
import { MemoryPaymentStore } from "@/lib/payments/store";
import { resetAdminLimitForTests } from "@/lib/server/admin";
import { DatabaseRequestError } from "@/lib/server/supabase-rest";
import { SupabaseAccountStore } from "@/lib/accounts/store-supabase";
import { SupabasePeerStore } from "@/lib/ocpi/store-supabase";
import { publicStatus } from "@/lib/server/status";
import {
  HOLD_SWEEP_MAX_AGE_MS,
  intervalWords,
  jobInterval,
  passes,
  publicStops,
  STOP_NAMES,
  type SetupStatus,
} from "@/lib/setup/checks";
import {
  checkDatabase,
  databaseCheck,
  PROBE_TIMEOUT_MS,
  setDatabaseCheckForTests,
  type DatabaseCheck,
} from "@/lib/setup/database";
import {
  FAILED_SAMPLE_MS,
  JOB_SAMPLE_MS,
  MAX_SETUP_ROWS_PER_DAY,
  JOB_SUBJECT,
  listJobRuns,
  flushWebhookNotesForTests,
  noteWebhook,
  recordJobRun,
  REFUSED_SAMPLE_MS,
  resetWebhookNotesForTests,
  WEBHOOK_FAILED,
  WEBHOOK_REFUSED,
  WEBHOOK_SUBJECT,
} from "@/lib/setup/log";
import { MIGRATIONS } from "@/lib/setup/migrations";
import {
  PUBLIC_VIEW_TTL_MS,
  publicSetupView,
  readSetupStatus,
  resetPublicSetupViewForTests,
  type SetupDeps,
} from "@/lib/setup/status";
import { setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { LIVE_ENV } from "./support/network";
import { applyMigrations, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

const FILES = MIGRATIONS.map((m) => m.file);
const OK: DatabaseCheck = {
  state: "ok",
  shipped: FILES.length,
  applied: FILES.length,
  pending: [],
  newest: FILES.at(-1)!,
};
const EMPTY: DatabaseCheck = {
  ...OK,
  state: "empty",
  applied: 0,
  pending: FILES,
};
const ADMINS_MIGRATION = "202610220007_accounts_payments.sql";
const UNREACHABLE: DatabaseCheck = {
  ...OK,
  state: "unreachable",
  applied: 0,
  pending: [],
};

// Secrets a status must never carry. Fakes, in the real formats.
const SECRETS = {
  STRIPE_SECRET_KEY: `sk_test_${"a1B2".repeat(8)}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${"c3D4".repeat(8)}`,
  CRON_SECRET: "cron-".repeat(8),
  ADMIN_SECRET: "admin-".repeat(8),
};
const LIVE = { ...LIVE_ENV, ...SECRETS };
// Every value of the configuration, and the hosts of its addresses.
const VALUES = [
  ...Object.values(LIVE),
  "db.example.test",
  "emsp.example.test",
  "NL-ABC",
];

const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const saved = { ...process.env };
let accounts: MemoryAccountStore;
let peers: MemoryPeerStore;
let payments: MemoryPaymentStore;
let database: DatabaseCheck;
let now: number;

const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
  accounts,
  peers,
  payments,
  database: async () => database,
  now: () => new Date(now),
  ...over,
});

/** A registered peer; with `hub`, a roaming hub with one trusted party. */
async function addPeer(status: "registered" | "pending" = "registered") {
  const peer = await peers.createPeer({
    label: "Example CPO",
    direction: "outbound",
    versionsUrl: "https://cpo.example.test/ocpi/versions",
  });
  if (status === "registered")
    await peers.updatePeer(peer.id, { status: "registered" });
  return peer;
}

/** A deployment with everything in place but the first admin. */
async function healthyButAdmin() {
  payments.newestEvent = {
    type: "payment_intent.succeeded",
    receivedAt: new Date(now - 60_000).toISOString(),
  };
  payments.sweptAt = new Date(now - 30_000).toISOString();
  await addPeer();
}

beforeEach(() => {
  process.env = { ...saved };
  for (const name of [...Object.keys(LIVE), "DEMO_MODE"])
    delete process.env[name];
  Object.assign(process.env, LIVE);
  accounts = new MemoryAccountStore();
  peers = new MemoryPeerStore();
  payments = new MemoryPaymentStore();
  database = OK;
  now = T0;
  setAccountStoreForTests(accounts);
  setPeerStoreForTests(peers);
  setPaymentStoreForTests(payments);
  setDatabaseCheckForTests(async () => database);
  resetPublicSetupViewForTests();
  resetWebhookNotesForTests();
  resetAdminLimitForTests();
  requestCookies.clear();
});
afterEach(() => {
  setAccountStoreForTests(undefined);
  setPeerStoreForTests(undefined);
  setPaymentStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setDatabaseCheckForTests(undefined);
  setTokenStoreForTests(undefined);
  setCommandStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setSessionStoreForTests(undefined);
  vi.useRealTimers();
  process.env = { ...saved };
});

describe("shipped migrations", () => {
  it("lists exactly the files in supabase/migrations, in order", () => {
    const onDisk = readdirSync(join(__dirname, "../supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(FILES).toEqual(onDisk);
  });

  describe("on PGlite", () => {
    let db: PGlite;
    afterEach(async () => {
      await db?.close();
    });

    it("each probe turns true with its own file, and the check counts them", async () => {
      db = await migratedDatabase({ before: FILES[0] });
      const transport = pgliteRest(db);
      expect(await checkDatabase(transport)).toEqual(EMPTY);
      for (const [i, file] of FILES.entries()) {
        // Everything up to and including this file, and nothing after it.
        await applyMigrations(db, { before: FILES[i + 1] });
        const check = await checkDatabase(transport);
        expect(check.pending, `after ${file}`).toEqual(FILES.slice(i + 1));
        expect(check.applied, `after ${file}`).toBe(i + 1);
        expect(check.state).toBe(i + 1 === FILES.length ? "ok" : "pending");
      }
    }, 120_000);

    it("the admin list of a database without its table is empty, by the list's own answer", async () => {
      // Every migration before the one that creates emsp_admins.
      db = await migratedDatabase({ before: ADMINS_MIGRATION });
      const transport = pgliteRest(db);
      const real = (): SetupDeps =>
        deps({
          accounts: new SupabaseAccountStore(
            LIVE.SUPABASE_URL,
            "test-key",
            transport,
          ),
          peers: new SupabasePeerStore(
            LIVE.SUPABASE_URL,
            "test-key",
            transport,
          ),
          database: () => checkDatabase(transport),
        });
      const status = await readSetupStatus(real());
      expect(status.database?.state).toBe("pending");
      expect(status.admins).toBe(0);
      expect(await publicSetupView(real())).toHaveLength(6);
      // With the table and someone on it, the view is gone.
      await applyMigrations(db);
      await db.exec(
        `insert into public.emsp_admins (user_id, role)
         values ('11111111-1111-4111-8111-111111111111', 'viewer')`,
      );
      resetPublicSetupViewForTests();
      expect(await publicSetupView(real())).toBeNull();
      expect((await readSetupStatus(real())).admins).toBe(1);
    }, 60_000);

    it("needs no ledger: files run by hand in the SQL editor count too", async () => {
      db = await migratedDatabase();
      await db.exec("drop table public.emsp_schema_migrations");
      expect(await checkDatabase(pgliteRest(db))).toEqual(OK);
    }, 60_000);
  });

  it("says unreachable, not empty, when the answer is not about the schema", async () => {
    const answers: (() => Promise<Response>)[] = [
      async () =>
        Response.json({ message: "Invalid API key" }, { status: 401 }),
      async () => new Response("upstream error", { status: 503 }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const answer of answers)
      expect(await checkDatabase(answer)).toEqual(UNREACHABLE);
    // PostgREST's own way to say "no such table": that is an answer.
    const none = await checkDatabase(async () =>
      Response.json({ code: "PGRST205", message: "x" }, { status: 404 }),
    );
    expect(none.state).toBe("empty");
  });

  it("remembers a passing check, asks again soon after any other, and afresh on request", async () => {
    let calls = 0;
    setDatabaseCheckForTests(async () => {
      calls += 1;
      return database;
    });
    database = EMPTY;
    await databaseCheck({ now: T0 });
    await databaseCheck({ now: T0 + 5_000 });
    expect(calls).toBe(1);
    database = OK;
    expect((await databaseCheck({ now: T0 + 20_000 })).state).toBe("ok");
    await databaseCheck({ now: T0 + 4 * 60_000 });
    expect(calls).toBe(2);
    await databaseCheck({ now: T0 + 4 * 60_000, fresh: true });
    expect(calls).toBe(3);
    await databaseCheck({ now: T0 + 10 * 60_000 });
    expect(calls).toBe(4);
  });
});

describe("the database check under load", () => {
  it("concurrent callers share one round of probes, cold and failing alike", async () => {
    let rounds = 0;
    setDatabaseCheckForTests(async () => {
      rounds += 1;
      await new Promise((r) => setTimeout(r, 10));
      return database;
    });
    const many = (at: number, fresh = false) =>
      Promise.all(
        Array.from({ length: 40 }, () => databaseCheck({ now: at, fresh })),
      );
    database = EMPTY;
    for (const check of await many(T0)) expect(check.state).toBe("empty");
    expect(rounds).toBe(1);
    // Kept for 15 seconds while it fails, then one round again, not 40.
    await many(T0 + 14_000);
    expect(rounds).toBe(1);
    await many(T0 + 16_000);
    expect(rounds).toBe(2);
    // Callers who ask afresh share a round too.
    await many(T0 + 17_000, true);
    expect(rounds).toBe(3);
    // Through the public status API: 40 calls, one round.
    database = OK;
    setDatabaseCheckForTests(async () => {
      rounds += 1;
      await new Promise((r) => setTimeout(r, 10));
      return database;
    });
    const answers = await Promise.all(
      Array.from({ length: 40 }, () => publicStatus()),
    );
    expect(new Set(answers.map((a) => a.mode))).toEqual(new Set(["live"]));
    expect(rounds).toBe(4);
  });

  it("a round is one request per shipped migration", async () => {
    let requests = 0;
    const check = await checkDatabase(async () => {
      requests += 1;
      return Response.json([]);
    });
    expect(check.state).toBe("ok");
    expect(requests).toBe(FILES.length);
  });

  it("a check that throws is shared and not remembered", async () => {
    let rounds = 0;
    setDatabaseCheckForTests(async () => {
      rounds += 1;
      throw new Error("down");
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => databaseCheck({ now: T0 })),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(rounds).toBe(1);
    expect(await publicStatus()).toMatchObject({ mode: "setup" });
    expect(rounds).toBe(2);
  });

  it("gives a database that does not answer a short time, then says unreachable", async () => {
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    const signals: AbortSignal[] = [];
    // Never answers; ends when the request's own time limit ends it.
    const silent = (_: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signals.push(init!.signal!);
        init!.signal!.addEventListener("abort", () =>
          reject(init!.signal!.reason),
        );
      });
    const started = Date.now();
    const check = await checkDatabase(silent, MIGRATIONS, 40);
    expect(check).toEqual(UNREACHABLE);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(signals).toHaveLength(FILES.length);
  });
});

describe("the public status API", () => {
  it("says live only when the database check passes", async () => {
    expect((await publicStatus()).mode).toBe("live");
    for (const state of ["empty", "pending", "unreachable"] as const) {
      setDatabaseCheckForTests(async () => ({ ...EMPTY, state }));
      const status = await publicStatus();
      expect(status.mode, state).toBe("setup");
      // The same three fields as ever: nothing about the database but that word.
      expect(Object.keys(status).sort()).toEqual(["mode", "name", "ocpi"]);
    }
    setDatabaseCheckForTests(async () => {
      throw new Error("boom");
    });
    expect((await publicStatus()).mode).toBe("setup");
  });

  it("says demo in demo mode without asking the database", async () => {
    process.env.DEMO_MODE = "true";
    setDatabaseCheckForTests(async () => {
      throw new Error("demo mode must not ask the database");
    });
    expect((await publicStatus()).mode).toBe("demo");
  });
});

describe("the setup status read", () => {
  it("reports names, times, results and counts, and no value of any setting", async () => {
    process.env.EMSP_PARTY_ID = "";
    process.env.RESEND_API_KEY = "bad";
    process.env.STRIPE_WEBHOOK_SECRET = "bad";
    accounts.admins.set("u1", "admin");
    accounts.admins.set("u2", "viewer");
    await healthyButAdmin();
    await addPeer("pending");
    const s = await readSetupStatus(deps());
    expect(s).toEqual({
      checkedAt: new Date(T0).toISOString(),
      demo: true,
      environment: {
        required: 6,
        missing: ["EMSP_PARTY_ID"],
        malformed: [
          "STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_)",
          "RESEND_API_KEY must be a Resend API key (re_)",
        ],
        malformedRequired: 0,
        demoForced: false,
        stripeKey: true,
        webhookSecret: false,
        cronSecret: true,
      },
      // Demo mode has no database, and does not ask one.
      database: null,
      webhook: {
        lastSigned: {
          at: new Date(T0 - 60_000).toISOString(),
          result: "handled",
        },
        lastRefused: null,
      },
      job: { runs: [], sweptAt: new Date(T0 - 30_000).toISOString() },
      admins: 2,
      peers: { total: 2, registered: 1, hubs: 0, trustedParties: 0 },
    });
    const sent = JSON.stringify(s);
    for (const value of [...VALUES, "bad", "example"])
      expect(sent, value).not.toContain(value);
  });

  it("reports the database check, and reads nothing else when there are no tables", async () => {
    const boom = async () => {
      throw new Error("no such table");
    };
    database = EMPTY;
    const s = await readSetupStatus(
      deps({
        accounts: { ...accounts, countAdmins: boom } as never,
        peers: { ...peers, listPeers: boom, listAudit: boom } as never,
        payments: { ...payments, lastEvent: boom, lastSweptAt: boom } as never,
      }),
    );
    expect(s.database).toEqual(EMPTY);
    // Nobody can be on a list that does not exist; the rest is not known.
    expect(s.admins).toBe(0);
    expect(s.peers?.registered).toBe(0);
    expect(s.webhook).toBeNull();
    expect(s.job).toBeNull();
    expect(passes(s, T0)).toEqual([true, false, false, false, false, false]);
  });

  it("says 'not known' for a part that could not be read, and that part does not pass", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await healthyButAdmin();
    accounts.admins.set("u1", "admin");
    const s = await readSetupStatus(
      deps({
        accounts: {
          countAdmins: async () => {
            throw new Error(`boom ${SECRETS.STRIPE_SECRET_KEY}`);
          },
        } as never,
      }),
    );
    expect(s.admins).toBeNull();
    expect(passes(s, T0)).toEqual([true, true, true, true, false, true]);
    // The log names the part and the error's name, never its message.
    expect(log.mock.calls.join(" ")).toContain("the admin list failed: Error");
    expect(log.mock.calls.join(" ")).not.toContain("sk_test_");
    log.mockRestore();
    // The admin list itself is asked: "no such table" is an empty list, and nothing
    // is concluded from another table's probe.
    database = { ...OK, state: "pending", pending: [ADMINS_MIGRATION] };
    const refusing = (code: string | null) =>
      deps({
        accounts: {
          countAdmins: async () => {
            throw new DatabaseRequestError("refused", 404, code);
          },
        } as never,
      });
    expect((await readSetupStatus(refusing("PGRST205"))).admins).toBe(0);
    expect((await readSetupStatus(refusing("42P01"))).admins).toBe(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await readSetupStatus(refusing("42501"))).admins).toBeNull();
    expect((await readSetupStatus(refusing(null))).admins).toBeNull();
    vi.restoreAllMocks();
  });

  it("tells the last signed event's result, and the last refused request", async () => {
    await healthyButAdmin();
    await peers.audit({
      actor: "stripe-webhook",
      action: WEBHOOK_REFUSED,
      subjectId: WEBHOOK_SUBJECT,
    });
    let s = await readSetupStatus(deps());
    expect(s.webhook?.lastSigned?.result).toBe("handled");
    expect(s.webhook?.lastRefused?.at).toMatch(/^20\d\d-/);
    // A refusal alone does not fail the stop: anyone can send one.
    expect(passes(s, T0)[2]).toBe(true);
    // A signed event that failed here, after the last handled one.
    payments.newestEvent!.receivedAt = new Date(
      Date.now() - 3_600_000,
    ).toISOString();
    await peers.audit({
      actor: "stripe-webhook",
      action: "webhook.failed",
      subjectId: WEBHOOK_SUBJECT,
    });
    s = await readSetupStatus(deps());
    expect(s.webhook?.lastSigned?.result).toBe("failed");
    expect(passes(s, T0)[2]).toBe(false);
  });
});

describe("the six checks", () => {
  const base = async (): Promise<SetupStatus> => {
    accounts.admins.set("u1", "admin");
    await healthyButAdmin();
    return readSetupStatus(deps());
  };

  it("keeps the sweep's age limit the same as the payment code's", () => {
    expect(HOLD_SWEEP_MAX_AGE_MS).toBe(SWEEP_MAX_AGE_MS);
  });

  it("all pass on a healthy deployment, and none in demo mode", async () => {
    const s = await base();
    expect(passes(s, T0)).toEqual([true, true, true, true, true, true]);
    expect(passes({ ...s, demo: true }, T0)).toEqual(
      STOP_NAMES.map(() => false),
    );
  });

  it("fails each stop for its own reason", async () => {
    const s = await base();
    const failing: [number, Partial<SetupStatus>][] = [
      [1, { database: { ...OK, state: "pending", pending: [FILES[3]] } }],
      [1, { database: UNREACHABLE }],
      [2, { environment: { ...s.environment, webhookSecret: false } }],
      [2, { environment: { ...s.environment, stripeKey: false } }],
      [2, { webhook: { lastSigned: null, lastRefused: null } }],
      [2, { webhook: null }],
      [3, { environment: { ...s.environment, cronSecret: false } }],
      [3, { job: null }],
      [3, { job: { runs: [], sweptAt: null } }],
      // Six minutes: older than a card hold accepts.
      [3, { job: { runs: [], sweptAt: new Date(T0 - 360_000).toISOString() } }],
      [
        3,
        {
          job: {
            runs: [{ at: s.checkedAt, ok: false, sinceLastS: 60 }],
            sweptAt: s.job!.sweptAt,
          },
        },
      ],
      // Fresh right now, but known to come once a day.
      [
        3,
        {
          job: {
            runs: [{ at: s.checkedAt, ok: true, sinceLastS: 86_400 }],
            sweptAt: s.job!.sweptAt,
          },
        },
      ],
      [4, { admins: 0 }],
      [4, { admins: null }],
      [5, { peers: { total: 1, registered: 0, hubs: 0, trustedParties: 0 } }],
      [5, { peers: null }],
    ];
    for (const [stop, change] of failing) {
      const expected = STOP_NAMES.map((_, i) => i !== stop);
      expect(passes({ ...s, ...change }, T0), JSON.stringify(change)).toEqual(
        expected,
      );
    }
  });

  it("reads how often the job runs from the wait recorded with its newest good run", () => {
    const run = (sinceLastS: number | null, ok = true) => ({
      at: "2026-11-24T12:00:00.000Z",
      ok,
      sinceLastS,
    });
    expect(jobInterval([])).toBeNull();
    expect(jobInterval([run(null)])).toBeNull();
    expect(jobInterval([run(61), run(60), run(59)])).toBe(61);
    // Entries are written on a change, so the newest says how the job runs now: a
    // job that was slow and now comes every minute is an every-minute job.
    expect(jobInterval([run(60), run(86_400), run(86_400)])).toBe(60);
    expect(jobInterval([run(3600), run(60), run(61)])).toBe(3600);
    // A failed run's wait is no pace: its sweep may not have finished.
    expect(jobInterval([run(900, false), run(86_400)])).toBe(86_400);
    expect(jobInterval([run(null), run(60)])).toBe(60);
    expect(intervalWords(60)).toBe("every minute");
    expect(intervalWords(600)).toBe("every 10 minutes");
    expect(intervalWords(7200)).toBe("every 2 hours");
    expect(intervalWords(86_400)).toBe("once a day");
  });
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TEN_MINUTES = 10 * MINUTE;

describe("recording job runs", () => {
  /** Moves the clock: the test's own, and the one the audit log stamps entries with. */
  const at = (ms: number) => {
    now = ms;
    vi.setSystemTime(ms);
  };
  const record = (ok = true, away: number | null = MINUTE) =>
    recordJobRun(
      { peers, now: () => new Date(now) },
      {
        ok,
        startedAt: new Date(now),
        sweptBefore: away === null ? null : new Date(now - away).toISOString(),
      },
    );
  const times = () => peers.auditLog.map((e) => Date.parse(e.at));
  beforeEach(() => {
    vi.useFakeTimers();
    at(T0);
  });

  it("the window is 10 minutes: a run just inside it is not recorded, one just outside is", async () => {
    expect(JOB_SAMPLE_MS).toBe(TEN_MINUTES);
    expect(await record(false)).toBe(true);
    at(T0 + TEN_MINUTES - 1);
    expect(await record(false)).toBe(false);
    // Not a change of outcome either, inside the window.
    expect(await record(true)).toBe(false);
    at(T0 + TEN_MINUTES);
    expect(await record(false)).toBe(true);
    expect(times()).toEqual([T0, T0 + TEN_MINUTES]);
  });

  it("a healthy job that runs every minute adds one entry on its first day, and none after", async () => {
    // A new deployment: no sweep has finished before the first run.
    expect(await record(true, null)).toBe(false);
    for (let minute = 1; minute < 1440; minute++) {
      at(T0 + minute * MINUTE);
      expect(await record(), `minute ${minute}`).toBe(minute === 1);
    }
    expect(peers.auditLog).toHaveLength(1);
    expect(peers.auditLog[0]).toMatchObject({
      actor: "cron",
      action: "job.run",
      subjectId: JOB_SUBJECT,
      details: { ok: true, since_last_s: 60 },
    });
    // The day after, and any steady day: nothing.
    for (let minute = 1440; minute < 2880; minute++) {
      at(T0 + minute * MINUTE);
      await record();
    }
    expect(peers.auditLog).toHaveLength(1);
    expect(jobInterval(await listJobRuns({ peers }))).toBe(60);
  });

  it("a job that fails all day adds one entry per window, never one per run", async () => {
    for (let minute = 0; minute < 1440; minute++) {
      at(T0 + minute * MINUTE);
      await record(false);
    }
    expect(peers.auditLog).toHaveLength(DAY / JOB_SAMPLE_MS);
    expect(peers.auditLog).toHaveLength(144);
    const t = times();
    for (let i = 1; i < t.length; i++)
      expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(TEN_MINUTES);
  });

  it("a job whose outcome alternates adds one entry per window too", async () => {
    for (let minute = 0; minute < 1440; minute++) {
      at(T0 + minute * MINUTE);
      await record(minute % 2 === 1);
    }
    expect(peers.auditLog.length).toBeLessThanOrEqual(144);
    const t = times();
    for (let i = 1; i < t.length; i++)
      expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(TEN_MINUTES);
  });

  it("records a change after a quiet window at once, and the recovery when the window ends", async () => {
    await record();
    expect(peers.auditLog).toHaveLength(1);
    // Hours later the job fails: the first change after a quiet window.
    at(T0 + 5 * 60 * MINUTE);
    expect(await record(false)).toBe(true);
    // It recovers a minute later; that is recorded once the window has passed.
    for (let minute = 1; minute < 10; minute++) {
      at(T0 + (5 * 60 + minute) * MINUTE);
      expect(await record(), `minute ${minute}`).toBe(false);
    }
    at(T0 + (5 * 60 + 10) * MINUTE);
    expect(await record()).toBe(true);
    at(T0 + (5 * 60 + 30) * MINUTE);
    expect(await record()).toBe(false);
    const runs = await listJobRuns({ peers });
    expect(runs.map((r) => r.ok)).toEqual([true, false, true]);
    // A good run with no sweep before it says nothing new after a good entry, but it
    // does end a failure.
    at(T0 + 7 * 60 * MINUTE);
    expect(await record(true, null)).toBe(false);
    expect(await record(false)).toBe(true);
    at(T0 + 8 * 60 * MINUTE);
    expect(await record(true, null)).toBe(true);
    expect((await listJobRuns({ peers }))[0]).toMatchObject({
      ok: true,
      sinceLastS: null,
    });
  });

  it("records every run of a once-a-day job, with how long it was away", async () => {
    for (let day = 0; day < 3; day++) {
      at(T0 + day * DAY);
      expect(await record(true, DAY)).toBe(true);
    }
    const runs = await listJobRuns({ peers });
    expect(runs).toHaveLength(3);
    expect(jobInterval(runs)).toBe(86_400);
    // The entry holds a time and an outcome, and nothing else.
    expect(peers.auditLog[0]).toEqual({
      actor: "cron",
      action: "job.run",
      subjectId: JOB_SUBJECT,
      details: { ok: true, since_last_s: 86_400 },
      at: expect.any(String),
    });
    // Moved to every minute, it is an every-minute job from the next entry on.
    at(T0 + 2 * DAY + MINUTE);
    expect(await record()).toBe(false);
    at(T0 + 2 * DAY + TEN_MINUTES);
    expect(await record()).toBe(true);
    expect(jobInterval(await listJobRuns({ peers }))).toBe(60);
  });

  it("never throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      listAudit: async () => {
        throw new Error("down");
      },
    } as never;
    expect(
      await recordJobRun(
        { peers: broken },
        { ok: false, startedAt: new Date(), sweptBefore: null },
      ),
    ).toBe(false);
    log.mockRestore();
  });
});

describe("the scheduled job's route", () => {
  it("the cron route records its run, and the status then knows the job", async () => {
    const call = () =>
      cronRoute.GET(
        new Request("https://emsp.example.test/api/cron/ocpi-sync", {
          headers: { Authorization: `Bearer ${SECRETS.CRON_SECRET}` },
        }),
      );
    setTokenStoreForTests(new MemoryTokenStore());
    setCommandStoreForTests(new MemoryCommandStore());
    setLocationStoreForTests(new MemoryLocationStore());
    setSessionStoreForTests(new MemorySessionStore());
    payments.sweptAt = new Date(Date.now() - 61_000).toISOString();
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const s = await readSetupStatus(deps({ now: undefined }));
    expect(s.job?.runs).toHaveLength(1);
    expect(s.job?.runs[0]).toMatchObject({ ok: true, sinceLastS: 61 });
    expect(Date.now() - Date.parse(s.job!.sweptAt!)).toBeLessThan(5_000);
    // The read of the last sweep failing does not stop the jobs: the sweep still runs.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = payments.lastSweptAt.bind(payments);
    let first = true;
    payments.lastSweptAt = async () => {
      if (first) {
        first = false;
        throw new Error("down");
      }
      return real();
    };
    const before = payments.sweptAt;
    await new Promise((r) => setTimeout(r, 5));
    expect((await call()).status).toBe(200);
    expect(Date.parse(payments.sweptAt!)).toBeGreaterThan(Date.parse(before!));
    expect(log.mock.calls.join(" ")).toContain("last payment sweep failed");
    log.mockRestore();
    payments.lastSweptAt = real;
    // In demo mode the job pulls nothing and records nothing.
    process.env.DEMO_MODE = "true";
    const demoPeers = new MemoryPeerStore();
    setPeerStoreForTests(demoPeers);
    expect((await call()).status).toBe(200);
    expect(demoPeers.auditLog).toEqual([]);
  });
});

describe("recording refused webhook requests", () => {
  const sign = (payload: string, secret: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  };
  const post = (payload: string, signature: string) =>
    webhookPOST(
      new Request("https://emsp.example.test/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: { "Stripe-Signature": signature },
      }),
    );
  const payload = JSON.stringify({
    id: "evt_setup1",
    type: "customer.created",
    data: { object: { object: "customer" } },
  });

  it("a flood of unsigned requests leaves one entry, with nothing of the request in it", async () => {
    const reads = vi.spyOn(peers, "listAudit");
    for (let i = 0; i < 50; i++)
      expect((await post(payload, sign(payload, "whsec_wrong"))).status).toBe(
        400,
      );
    await flushWebhookNotesForTests();
    expect(peers.auditLog).toHaveLength(1);
    // And one read of the audit log: the rest are stopped by the process's own memory.
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    expect(peers.auditLog[0]).toEqual({
      actor: "stripe-webhook",
      action: WEBHOOK_REFUSED,
      subjectId: WEBHOOK_SUBJECT,
      at: expect.any(String),
    });
    const s = await readSetupStatus(deps());
    expect(s.webhook).toEqual({
      lastSigned: null,
      lastRefused: { at: peers.auditLog[0].at },
    });
  });

  it("another server process does not add a second entry within the window", async () => {
    const at = { now: () => new Date(now) };
    expect(await noteWebhook({ peers, ...at }, WEBHOOK_REFUSED)).toBe(true);
    // A new process has no memory of its own: the newest entry stops it.
    resetWebhookNotesForTests();
    expect(await noteWebhook({ peers }, WEBHOOK_REFUSED)).toBe(false);
    resetWebhookNotesForTests();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + REFUSED_SAMPLE_MS + 1_000);
    expect(await noteWebhook({ peers }, WEBHOOK_REFUSED)).toBe(true);
    expect(peers.auditLog).toHaveLength(2);
  });

  for (const [action, sample] of [
    [WEBHOOK_REFUSED, REFUSED_SAMPLE_MS],
    [WEBHOOK_FAILED, FAILED_SAMPLE_MS],
  ] as const) {
    it(`${action}: the window is 10 minutes, in one server process and across them`, async () => {
      expect(sample).toBe(TEN_MINUTES);
      vi.useFakeTimers();
      const set = (ms: number) => {
        now = ms;
        vi.setSystemTime(ms);
      };
      const note = () =>
        noteWebhook({ peers, now: () => new Date(now) }, action);
      // One process, by its own memory.
      set(T0);
      expect(await note()).toBe(true);
      set(T0 + TEN_MINUTES - 1);
      expect(await note()).toBe(false);
      set(T0 + TEN_MINUTES);
      expect(await note()).toBe(true);
      // A new process each time, by the newest entry of the kind.
      set(T0 + 2 * TEN_MINUTES - 1);
      resetWebhookNotesForTests();
      expect(await note()).toBe(false);
      set(T0 + 2 * TEN_MINUTES);
      resetWebhookNotesForTests();
      expect(await note()).toBe(true);
      expect(peers.auditLog.map((e) => Date.parse(e.at) - T0)).toEqual([
        0,
        TEN_MINUTES,
        2 * TEN_MINUTES,
      ]);
      // Time and kind only: nothing of a request.
      for (const entry of peers.auditLog)
        expect(entry).toEqual({
          actor: "stripe-webhook",
          action,
          subjectId: WEBHOOK_SUBJECT,
          at: expect.any(String),
        });
    });
  }

  it("entries of the other kind do not hide the newest refused one from another process", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    expect(await noteWebhook({ peers }, WEBHOOK_REFUSED)).toBe(true);
    // More failed entries than any read of "the newest few" would look through.
    for (let i = 1; i <= 25; i++) {
      vi.setSystemTime(T0 + i * 1_000);
      await peers.audit({
        actor: "stripe-webhook",
        action: WEBHOOK_FAILED,
        subjectId: WEBHOOK_SUBJECT,
      });
    }
    vi.setSystemTime(T0 + 5 * MINUTE);
    resetWebhookNotesForTests();
    expect(await noteWebhook({ peers }, WEBHOOK_REFUSED)).toBe(false);
    expect(
      peers.auditLog.filter((e) => e.action === WEBHOOK_REFUSED),
    ).toHaveLength(1);
  });

  it("a signed event is the last signed one, handled", async () => {
    expect(
      (await post(payload, sign(payload, SECRETS.STRIPE_WEBHOOK_SECRET)))
        .status,
    ).toBe(200);
    const s = await readSetupStatus(deps());
    expect(s.webhook?.lastSigned?.result).toBe("handled");
    expect(peers.auditLog).toEqual([]);
  });

  it("a signed event that fails here is recorded as failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    payments.recordEvent = async () => {
      throw new Error("down");
    };
    expect(
      (await post(payload, sign(payload, SECRETS.STRIPE_WEBHOOK_SECRET)))
        .status,
    ).toBe(500);
    await flushWebhookNotesForTests();
    log.mockRestore();
    const s = await readSetupStatus(deps());
    expect(s.webhook?.lastSigned?.result).toBe("failed");
  });

  it("the answer never waits for the note, and is the same when it cannot be written", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // A database that never answers the note's read.
    peers.listAudit = () => new Promise(() => {});
    expect((await post(payload, sign(payload, "whsec_wrong"))).status).toBe(
      400,
    );
    payments.recordEvent = async () => {
      throw new Error("down");
    };
    expect(
      (await post(payload, sign(payload, SECRETS.STRIPE_WEBHOOK_SECRET)))
        .status,
    ).toBe(500);
    // One that refuses it.
    resetWebhookNotesForTests();
    peers.listAudit = async () => {
      throw new Error("down");
    };
    expect((await post(payload, sign(payload, "whsec_wrong"))).status).toBe(
      400,
    );
    await flushWebhookNotesForTests();
    expect(peers.auditLog).toEqual([]);
    log.mockRestore();
  });
});

describe("what the checks add to the audit log in a day", () => {
  const set = (ms: number) => {
    now = ms;
    vi.setSystemTime(ms);
  };
  const clock = { now: () => new Date(now) };
  const run = (ok: boolean) =>
    recordJobRun(
      { peers, ...clock },
      {
        ok,
        startedAt: new Date(now),
        sweptBefore: new Date(now - MINUTE).toISOString(),
      },
    );
  const count = (action: string) =>
    peers.auditLog.filter((e) => e.action === action).length;

  it("at worst 432 entries: 144 of each kind", () => {
    expect(MAX_SETUP_ROWS_PER_DAY).toBe(432);
    expect(MAX_SETUP_ROWS_PER_DAY).toBe(
      DAY / JOB_SAMPLE_MS + DAY / REFUSED_SAMPLE_MS + DAY / FAILED_SAMPLE_MS,
    );
  });

  it("the worst day stays within it: the job flaps, every event fails, unsigned requests never stop, servers restart", async () => {
    vi.useFakeTimers();
    for (let step = 0; step < DAY / 20_000; step++) {
      set(T0 + step * 20_000);
      // A new server process every few minutes: no memory of its own.
      if (step % 7 === 0) resetWebhookNotesForTests();
      if (step % 3 === 0) await run(step % 2 === 0);
      await noteWebhook({ peers, ...clock }, WEBHOOK_REFUSED);
      await noteWebhook({ peers, ...clock }, WEBHOOK_FAILED);
    }
    expect(count("job.run")).toBeLessThanOrEqual(144);
    expect(count(WEBHOOK_REFUSED)).toBe(144);
    expect(count(WEBHOOK_FAILED)).toBe(144);
    expect(peers.auditLog.length).toBeLessThanOrEqual(MAX_SETUP_ROWS_PER_DAY);
    expect(peers.auditLog.length).toBeGreaterThan(400);
  });

  it("a healthy day adds nothing: the job runs every minute and signed events are handled", async () => {
    vi.useFakeTimers();
    set(T0);
    await run(true);
    expect(peers.auditLog).toHaveLength(1);
    for (let minute = 1; minute <= 1440; minute++) {
      set(T0 + minute * MINUTE);
      await run(true);
    }
    expect(peers.auditLog).toHaveLength(1);
  });

  it("a steadily failing deployment adds one entry per kind per window", async () => {
    vi.useFakeTimers();
    for (let minute = 0; minute < 60; minute++) {
      set(T0 + minute * MINUTE);
      await run(false);
      await noteWebhook({ peers, ...clock }, WEBHOOK_FAILED);
    }
    expect(count("job.run")).toBe(6);
    expect(count(WEBHOOK_FAILED)).toBe(6);
  });
});

describe("the public view, before the first admin", () => {
  it("is the six fixed names with pass or fail, and nothing else", async () => {
    await healthyButAdmin();
    const view = await publicSetupView(deps());
    expect(view).toEqual([
      { name: "Environment", pass: true },
      { name: "Database", pass: true },
      { name: "Payments webhook", pass: true },
      { name: "Scheduled job", pass: true },
      { name: "First admin", pass: false },
      { name: "First peer", pass: true },
    ]);
    for (const stop of view!)
      expect(Object.keys(stop).sort()).toEqual(["name", "pass"]);
    const sent = JSON.stringify(view);
    for (const value of VALUES) expect(sent).not.toContain(value);
    // No variable name, no time, no count: no digit at all.
    expect(sent).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+|\d/);
  });

  it("does not change with what lies behind a pass or a fail", async () => {
    await healthyButAdmin();
    const one = JSON.stringify(await publicSetupView(deps()));
    // Other times, other counts, another configuration: the same six answers.
    payments.newestEvent!.receivedAt = new Date(now - 86_400_000).toISOString();
    payments.sweptAt = new Date(now - 200_000).toISOString();
    for (let i = 0; i < 4; i++) await addPeer();
    await addPeer("pending");
    await peers.audit({
      actor: "stripe-webhook",
      action: WEBHOOK_REFUSED,
      subjectId: WEBHOOK_SUBJECT,
    });
    await recordJobRun(
      { peers },
      { ok: true, startedAt: new Date(), sweptBefore: payments.sweptAt },
    );
    Object.assign(process.env, {
      EMSP_COUNTRY_CODE: "DE",
      EMSP_PARTY_ID: "X7Z",
      PUBLIC_BASE_URL: "https://other.example.net",
      HOLD_AMOUNTS: "EUR:3000",
    });
    resetPublicSetupViewForTests();
    expect(JSON.stringify(await publicSetupView(deps()))).toBe(one);
  });

  it("says pass or fail per stop as the facts change", async () => {
    // Worked out anew each time, as by a server process that kept nothing.
    const pass = async () => {
      resetPublicSetupViewForTests();
      return (await publicSetupView(deps()))!.map((stop) => stop.pass);
    };
    expect(await pass()).toEqual([true, true, false, false, false, false]);
    database = EMPTY;
    expect(await pass()).toEqual([true, false, false, false, false, false]);
    database = { ...OK, state: "pending", pending: [ADMINS_MIGRATION] };
    expect(await pass()).toEqual([true, false, false, false, false, false]);
    database = OK;
    await healthyButAdmin();
    process.env.STRIPE_WEBHOOK_SECRET = "";
    process.env.CRON_SECRET = "";
    expect(await pass()).toEqual([true, true, false, false, false, true]);
  });

  it("is gone once an admin exists, whatever their role", async () => {
    await healthyButAdmin();
    accounts.admins.set("u1", "viewer");
    // The first time the server works it out, it is gone.
    expect(await publicSetupView(deps())).toBeNull();
    // And stays gone without asking again for a minute.
    const asked = vi.spyOn(accounts, "hasAdmin");
    now += 30_000;
    expect(await publicSetupView(deps())).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });

  it("outlives the first admin by at most the time it is kept", async () => {
    await healthyButAdmin();
    expect(await publicSetupView(deps())).not.toBeNull();
    accounts.admins.set("u1", "admin");
    now += PUBLIC_VIEW_TTL_MS - 1;
    expect(await publicSetupView(deps())).not.toBeNull();
    now += 1;
    expect(await publicSetupView(deps())).toBeNull();
    // Removing the admin does not bring it back for a minute.
    accounts.admins.clear();
    now += 59_000;
    expect(await publicSetupView(deps())).toBeNull();
  });

  it("any number of visitors at once cost one round of small reads", async () => {
    await healthyButAdmin();
    let checks = 0;
    const d = deps({
      database: async () => {
        checks += 1;
        await new Promise((r) => setTimeout(r, 5));
        return database;
      },
    });
    const reads = [
      vi.spyOn(accounts, "hasAdmin"),
      vi.spyOn(peers, "hasRegisteredPeer"),
      vi.spyOn(payments, "lastEvent"),
      vi.spyOn(payments, "lastSweptAt"),
    ];
    const audit = vi.spyOn(peers, "listAudit");
    // Whole tables are never read for a visitor.
    const rows = [
      vi.spyOn(peers, "listPeers"),
      vi.spyOn(accounts, "countAdmins"),
    ];
    const views = await Promise.all(
      Array.from({ length: 40 }, () => publicSetupView(d)),
    );
    for (const view of views) expect(view).toEqual(views[0]);
    expect(views[0]).toHaveLength(6);
    for (const read of reads) expect(read).toHaveBeenCalledTimes(1);
    // The job runs and the webhook notes: a few rows each.
    expect(audit).toHaveBeenCalledTimes(2);
    for (const [, limit] of audit.mock.calls)
      expect(limit).toBeLessThanOrEqual(20);
    for (const read of rows) expect(read).not.toHaveBeenCalled();
    // The database check is asked for twice in the round; the real one remembers.
    expect(checks).toBe(2);
    // While the answer is kept, visitors cost nothing at all.
    now += PUBLIC_VIEW_TTL_MS - 1;
    await Promise.all(Array.from({ length: 40 }, () => publicSetupView(d)));
    for (const read of reads) expect(read).toHaveBeenCalledTimes(1);
    expect(checks).toBe(2);
    // Then one more round.
    now += 1;
    await Promise.all(Array.from({ length: 40 }, () => publicSetupView(d)));
    for (const read of reads) expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a database that does not answer", async () => {
    await healthyButAdmin();
    const hanging = deps({
      accounts: { hasAdmin: () => new Promise<boolean>(() => {}) } as never,
    });
    const started = Date.now();
    const views = await Promise.all(
      Array.from({ length: 10 }, () =>
        publicSetupView(hanging, { deadlineMs: 30 }),
      ),
    );
    expect(views).toEqual(Array(10).fill(null));
    expect(Date.now() - started).toBeLessThan(1_000);
    // "Cannot tell" is kept too: the next visitor does not wait at all.
    const asked = vi.spyOn(peers, "hasRegisteredPeer");
    expect(await publicSetupView(deps())).toBeNull();
    expect(asked).not.toHaveBeenCalled();
    now += PUBLIC_VIEW_TTL_MS;
    expect(await publicSetupView(deps())).not.toBeNull();
  });

  it("is not shown when the server cannot tell that no admin exists", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await healthyButAdmin();
    const view = (d: SetupDeps) => {
      resetPublicSetupViewForTests();
      return publicSetupView(d);
    };
    // The database does not answer.
    database = UNREACHABLE;
    expect(await view(deps())).toBeNull();
    // The admin list cannot be read: an error, or a refusal that is not "no table".
    database = OK;
    for (const error of [
      new Error("down"),
      new DatabaseRequestError("refused", 401, null),
      new DatabaseRequestError("refused", 403, "42501"),
    ]) {
      const unreadable = {
        hasAdmin: async () => {
          throw error;
        },
      } as never;
      expect(await view(deps({ accounts: unreadable }))).toBeNull();
    }
    // With the admin table's migration pending the list is still asked, not assumed
    // empty from another table's probe.
    database = { ...OK, state: "pending", pending: [ADMINS_MIGRATION] };
    accounts.admins.set("u1", "admin");
    expect(await view(deps())).toBeNull();
    accounts.admins.clear();
    // The check itself fails.
    expect(
      await view(
        deps({
          database: async () => {
            throw new Error("down");
          },
        }),
      ),
    ).toBeNull();
    log.mockRestore();
  });

  it("is shown for a database whose admin table does not exist yet", async () => {
    database = { ...OK, state: "pending", pending: [ADMINS_MIGRATION] };
    const none = {
      hasAdmin: async () => {
        throw new DatabaseRequestError("refused", 404, "PGRST205");
      },
    } as never;
    expect(await publicSetupView(deps({ accounts: none }))).toHaveLength(6);
  });

  it("in demo mode: six names, none done, whatever is configured", async () => {
    const none = STOP_NAMES.map((name) => ({ name, pass: false }));
    process.env.DEMO_MODE = "true";
    await healthyButAdmin();
    expect(await publicSetupView(deps())).toEqual(none);
    // Demo for another reason: unset and malformed settings.
    process.env.DEMO_MODE = "";
    for (const name of Object.keys(LIVE_ENV)) process.env[name] = "";
    process.env.STRIPE_SECRET_KEY = "bad";
    resetPublicSetupViewForTests();
    expect(await publicSetupView(deps())).toEqual(none);
  });

  it("publicStops takes nothing from the status but the six answers", async () => {
    accounts.admins.set("u1", "admin");
    await healthyButAdmin();
    const s = await readSetupStatus(deps());
    expect(JSON.stringify(publicStops(s, T0))).toBe(
      JSON.stringify(STOP_NAMES.map((name) => ({ name, pass: true }))),
    );
  });
});

describe("the setup status action", () => {
  const form = (values: Record<string, string> = {}) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(k, v);
    return f;
  };
  const signIn = (role: "admin" | "viewer") => {
    accounts.admins.set("u1", role);
    setAuthProviderForTests({
      getUser: async (token: string) =>
        token === "good" ? { id: "u1", email: "ana@example.com" } : null,
    } as unknown as AuthProvider);
    requestCookies.set(ADMIN_COOKIE, "good");
  };

  it("answers nobody who is not signed in: no status, before or after the first admin", async () => {
    for (const admins of [0, 1]) {
      if (admins) accounts.admins.set("u9", "admin");
      for (const values of [{}, { adminSecret: "wrong" }] as Record<
        string,
        string
      >[]) {
        const answer = await setupStatusAction({}, form(values));
        expect(answer.ok).toBe(false);
        expect(answer.code).toBe("wrong_secret");
        expect(answer.status).toBeUndefined();
        expect(Object.keys(answer).sort()).toEqual([
          "code",
          "message",
          "nextStep",
          "ok",
        ]);
      }
    }
    // Without ADMIN_SECRET on the server there is no secret to try.
    process.env.ADMIN_SECRET = "";
    const answer = await setupStatusAction({}, form({ adminSecret: "x" }));
    expect(answer).toMatchObject({ ok: false, code: "admin_disabled" });
    expect(answer.status).toBeUndefined();
  });

  it("answers a signed-in admin, a read-only one too, and the admin secret", async () => {
    const secret = await setupStatusAction(
      {},
      form({ adminSecret: SECRETS.ADMIN_SECRET }),
    );
    expect(secret.status?.admins).toBe(0);
    for (const role of ["admin", "viewer"] as const) {
      signIn(role);
      const answer = await setupStatusAction({}, form());
      expect(answer.ok, role).toBe(true);
      expect(answer.status?.admins).toBe(1);
      const sent = JSON.stringify(answer);
      for (const value of VALUES) expect(sent).not.toContain(value);
    }
    // A session that is not on the admin list is a visitor.
    accounts.admins.clear();
    expect((await setupStatusAction({}, form())).status).toBeUndefined();
  });
});

describe("what the reads ask the database for", () => {
  const asked: string[] = [];
  const transport = async (input: string | URL) => {
    asked.push(String(input).replace("https://db.example.test/rest/v1/", ""));
    return Response.json([]);
  };
  const URL_ = "https://db.example.test";

  it("setup's audit entries by subject type and id, so the index is used", async () => {
    asked.length = 0;
    const store = new SupabasePeerStore(URL_, "test-key", transport);
    await listJobRuns({ peers: store });
    await store.listAudit("11111111-1111-4111-8111-111111111111", 5);
    expect(asked[0]).toMatch(
      /^emsp_audit_log\?subject_type=eq\.setup&subject_id=eq\.setup%3Ajob&order=occurred_at\.desc,id\.desc&limit=5&/,
    );
    // Any other subject is asked for as before.
    expect(asked[1]).toMatch(/^emsp_audit_log\?subject_id=eq\.1111/);
    // The newest entry of one kind is asked for by kind.
    await store.listAudit("setup:stripe-webhook", 1, "webhook.refused");
    expect(asked[2]).toMatch(
      /^emsp_audit_log\?subject_type=eq\.setup&subject_id=eq\.setup%3Astripe-webhook&action=eq\.webhook\.refused&order=occurred_at\.desc,id\.desc&limit=1&/,
    );
  });

  it("one row to know whether there is an admin, or a registered peer", async () => {
    asked.length = 0;
    await new SupabaseAccountStore(URL_, "test-key", transport).hasAdmin();
    await new SupabasePeerStore(
      URL_,
      "test-key",
      transport,
    ).hasRegisteredPeer();
    expect(asked).toEqual([
      "emsp_admins?select=role&limit=1",
      "emsp_ocpi_peers?status=eq.registered&select=id&limit=1",
    ]);
  });
});
