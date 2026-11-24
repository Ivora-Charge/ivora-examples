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
  setDatabaseCheckForTests,
  type DatabaseCheck,
} from "@/lib/setup/database";
import {
  JOB_SAMPLE_MS,
  JOB_SUBJECT,
  listJobRuns,
  noteWebhook,
  recordJobRun,
  REFUSED_SAMPLE_MS,
  resetWebhookNotesForTests,
  WEBHOOK_REFUSED,
  WEBHOOK_SUBJECT,
} from "@/lib/setup/log";
import { ADMINS_MIGRATION, MIGRATIONS } from "@/lib/setup/migrations";
import {
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
    expect(FILES).toContain(ADMINS_MIGRATION);
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
    // With the admin migration pending, the list is known to be empty.
    database = { ...OK, state: "pending", pending: [ADMINS_MIGRATION] };
    const pending = await readSetupStatus(
      deps({
        accounts: {
          countAdmins: async () => {
            throw new Error("no such table");
          },
        } as never,
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(pending.admins).toBe(0);
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

  it("reads how often the job runs from the waits recorded with its runs", () => {
    const run = (sinceLastS: number | null, ok = true) => ({
      at: "2026-11-24T12:00:00.000Z",
      ok,
      sinceLastS,
    });
    expect(jobInterval([])).toBeNull();
    expect(jobInterval([run(null)])).toBeNull();
    expect(jobInterval([run(61), run(60), run(59)])).toBe(60);
    // One late run does not make an every-minute job a slow one.
    expect(jobInterval([run(3600), run(60), run(61)])).toBe(61);
    expect(jobInterval([run(86_400), run(86_400, false)])).toBe(86_400);
    expect(intervalWords(60)).toBe("every minute");
    expect(intervalWords(600)).toBe("every 10 minutes");
    expect(intervalWords(7200)).toBe("every 2 hours");
    expect(intervalWords(86_400)).toBe("once a day");
  });
});

describe("recording job runs", () => {
  const swept = (ago: number) => new Date(now - ago).toISOString();
  const record = (ok = true, away = 60_000) =>
    recordJobRun(
      { peers, now: () => new Date(now) },
      { ok, startedAt: new Date(now), sweptBefore: swept(away) },
    );

  it("records the first run, then one an hour, and any change of outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    expect(await record()).toBe(true);
    for (let minute = 1; minute < 60; minute++) {
      now = T0 + minute * 60_000;
      vi.setSystemTime(now);
      expect(await record(), `minute ${minute}`).toBe(false);
    }
    now = T0 + JOB_SAMPLE_MS;
    vi.setSystemTime(now);
    expect(await record()).toBe(true);
    // A failure is recorded at once, and so is the recovery.
    now += 60_000;
    vi.setSystemTime(now);
    expect(await record(false)).toBe(true);
    now += 60_000;
    vi.setSystemTime(now);
    expect(await record(false)).toBe(false);
    now += 60_000;
    vi.setSystemTime(now);
    expect(await record(true)).toBe(true);
    const runs = await listJobRuns({ peers });
    expect(runs.map((r) => r.ok)).toEqual([true, false, true, true]);
    expect(runs.every((r) => r.sinceLastS === 60)).toBe(true);
    // A day of every-minute runs leaves a few dozen entries, not 1,440.
    expect(peers.auditLog.length).toBe(4);
  });

  it("records every run of a once-a-day job, with how long it was away", async () => {
    vi.useFakeTimers();
    for (let day = 0; day < 3; day++) {
      now = T0 + day * 86_400_000;
      vi.setSystemTime(now);
      expect(await record(true, 86_400_000)).toBe(true);
    }
    const runs = await listJobRuns({ peers });
    expect(runs).toHaveLength(3);
    expect(jobInterval(runs)).toBe(86_400);
    // The entry holds a time and an outcome, and nothing else.
    expect(peers.auditLog[0]).toMatchObject({
      actor: "cron",
      action: "job.run",
      subjectId: JOB_SUBJECT,
      details: { ok: true, since_last_s: 86_400 },
    });
  });

  it("never throws, and the first run has no wait to report", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      listAudit: async () => {
        throw new Error("down");
      },
    } as never;
    expect(
      await recordJobRun(
        { peers: broken },
        { ok: true, startedAt: new Date(), sweptBefore: null },
      ),
    ).toBe(false);
    log.mockRestore();
    await recordJobRun(
      { peers },
      { ok: true, startedAt: new Date(), sweptBefore: null },
    );
    expect((await listJobRuns({ peers }))[0].sinceLastS).toBeNull();
  });

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
    for (let i = 0; i < 50; i++)
      expect((await post(payload, sign(payload, "whsec_wrong"))).status).toBe(
        400,
      );
    expect(peers.auditLog).toHaveLength(1);
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
    log.mockRestore();
    const s = await readSetupStatus(deps());
    expect(s.webhook?.lastSigned?.result).toBe("failed");
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
    expect(JSON.stringify(await publicSetupView(deps()))).toBe(one);
  });

  it("says pass or fail per stop as the facts change", async () => {
    const pass = async () =>
      (await publicSetupView(deps()))!.map((stop) => stop.pass);
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

  it("is gone the moment an admin exists, whatever their role", async () => {
    await healthyButAdmin();
    expect(await publicSetupView(deps())).not.toBeNull();
    accounts.admins.set("u1", "viewer");
    expect(await publicSetupView(deps())).toBeNull();
    // And stays gone without asking again for a minute.
    const asked = vi.spyOn(accounts, "countAdmins");
    expect(await publicSetupView(deps())).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });

  it("is not shown when the server cannot tell that no admin exists", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await healthyButAdmin();
    // The database does not answer.
    database = UNREACHABLE;
    expect(await publicSetupView(deps())).toBeNull();
    // The admin list cannot be read.
    database = OK;
    const unreadable = {
      countAdmins: async () => {
        throw new Error("down");
      },
    } as never;
    expect(await publicSetupView(deps({ accounts: unreadable }))).toBeNull();
    // The check itself fails.
    expect(
      await publicSetupView(
        deps({
          database: async () => {
            throw new Error("down");
          },
        }),
      ),
    ).toBeNull();
    log.mockRestore();
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
