import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveDeps } from "@/lib/server/live/service";
import type { LiveStore } from "@/lib/server/live/types";
import {
  parseEvent,
  signIvora,
  verifyIvoraSignature,
} from "@/lib/server/live/webhook";

// Webhook signature checks with fixed secrets and payloads, and the route itself with
// the store and the Ivora client replaced. No network, no real credentials.

const SECRET = "whsec_test_not_real";
const NOW = 1_800_000_000;

describe("Ivora-Signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "webhook.test", data: {} });

  it("accepts the HMAC-SHA256 of '<t>.<raw body>', also among rotated secrets", () => {
    const h = signIvora(body, SECRET, NOW);
    expect(verifyIvoraSignature(body, h, SECRET, NOW)).toEqual({ ok: true });
    const other = signIvora(body, "old_secret", NOW).split(",")[1];
    expect(verifyIvoraSignature(body, `${h},${other}`, SECRET, NOW)).toEqual({
      ok: true,
    });
  });

  it("refuses missing, malformed, stale and wrong signatures", () => {
    const h = signIvora(body, SECRET, NOW);
    expect(verifyIvoraSignature(body, null, SECRET, NOW)).toMatchObject({
      reason: "missing",
    });
    expect(verifyIvoraSignature(body, h, "", NOW)).toMatchObject({
      reason: "missing",
    });
    expect(verifyIvoraSignature(body, "v1=abc", SECRET, NOW)).toMatchObject({
      reason: "malformed",
    });
    expect(verifyIvoraSignature(body, h, SECRET, NOW + 301)).toMatchObject({
      reason: "stale",
    });
    expect(verifyIvoraSignature(`${body} `, h, SECRET, NOW)).toMatchObject({
      reason: "mismatch",
    });
    expect(
      verifyIvoraSignature(body, signIvora(body, "wrong", NOW), SECRET, NOW),
    ).toMatchObject({ reason: "mismatch" });
  });

  it("parses only well-formed events", () => {
    expect(parseEvent(body)).toMatchObject({ id: "evt_1" });
    expect(parseEvent("not json")).toBeNull();
    expect(
      parseEvent(JSON.stringify({ id: 1, type: "x", data: {} })),
    ).toBeNull();
    expect(parseEvent(JSON.stringify({ id: "e", type: "x" }))).toBeNull();
  });
});

// The route, with getLive() and after() replaced.
const live = vi.hoisted(() => ({ deps: null as unknown as LiveDeps }));
const later = vi.hoisted(() => ({ jobs: [] as (() => Promise<void>)[] }));
vi.mock("@/lib/server/live", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/live")>()),
  getLive: () => live.deps,
}));
// Driver checkouts at the event's station are settled after the response.
const settled = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/lib/server/checkout", () => ({
  getCheckout: () => ({ fake: "checkout deps" }),
  settleOpenCheckouts: async (_d: unknown, o: unknown) => {
    settled.calls.push(o);
    return 0;
  },
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (job: () => Promise<void>) => later.jobs.push(job),
}));

function fakeStore() {
  const seen = new Set<string>();
  const processed: string[] = [];
  const store = {
    mode: "live",
    recordEvent: vi.fn(async (e: { id: string }) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    }),
    markProcessed: vi.fn(async (id: string) => {
      processed.push(id);
    }),
    findByOperation: vi.fn(async () => null),
  } as unknown as LiveStore;
  return { store, processed };
}

describe("webhook route", () => {
  const saved = { ...process.env };
  let POST: (req: Request) => Promise<Response>;
  let processed: string[];
  beforeEach(async () => {
    process.env.IVORA_API_KEY = "test-key-not-real";
    process.env.IVORA_TENANT_ID = "42";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
    process.env.IVORA_WEBHOOK_SECRET = SECRET;
    delete process.env.DEMO_MODE;
    const f = fakeStore();
    processed = f.processed;
    live.deps = {
      store: f.store,
      ivora: { mode: "live" } as LiveDeps["ivora"],
    };
    later.jobs = [];
    settled.calls = [];
    ({ POST } = await import("@/app/api/webhooks/ivora/route"));
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const deliver = (event: object, sign = true, secret = SECRET) => {
    const raw = JSON.stringify(event);
    return POST(
      new Request("https://ops.example.test/api/webhooks/ivora", {
        method: "POST",
        headers: sign ? { "ivora-signature": signIvora(raw, secret) } : {},
        body: raw,
      }),
    );
  };
  const event = {
    id: "evt_10",
    type: "connector.status_changed",
    tenant_id: 42,
    station_id: 70,
    data: { connector_id: 701, status: "Charging" },
  };

  it("acknowledges a verified event at once and processes it once", async () => {
    const r = await deliver(event);
    expect(r.status).toBe(200);
    // The work runs after the response.
    expect(processed).toEqual([]);
    expect(later.jobs).toHaveLength(1);
    await later.jobs[0]();
    expect(processed).toEqual(["evt_10"]);
    // A charger event is a cue for that station's driver checkouts.
    expect(settled.calls).toEqual([{ stationId: 70 }]);
    expect(live.deps.store.recordEvent).toHaveBeenCalledWith({
      id: "evt_10",
      type: "connector.status_changed",
      stationId: 70,
    });
    // A redelivery is acknowledged without processing it again.
    const again = await deliver(event);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(later.jobs).toHaveLength(1);
  });

  it("passes on a transaction ID the event carries, as a hint", async () => {
    await deliver({
      ...event,
      id: "evt_11",
      type: "meter.sampled",
      data: { transaction_id: 1201, connector_id: 701 },
    });
    await deliver({
      ...event,
      id: "evt_12",
      data: { transaction: { id: 1202 } },
    });
    await deliver({ ...event, id: "evt_13", data: { transaction_id: "x" } });
    for (const job of later.jobs) await job();
    expect(settled.calls).toEqual([
      { stationId: 70, transactionId: 1201 },
      { stationId: 70, transactionId: 1202 },
      { stationId: 70 },
    ]);
  });

  it("refuses unsigned, wrongly signed and other tenants' events", async () => {
    expect((await deliver(event, false)).status).toBe(401);
    expect((await deliver(event, true, "wrong")).status).toBe(401);
    expect((await deliver({ ...event, tenant_id: 43 })).status).toBe(400);
    expect((await deliver({ type: "x" })).status).toBe(400);
    expect(live.deps.store.recordEvent).not.toHaveBeenCalled();
  });

  it("does not acknowledge an event it could not store, so Ivora retries", async () => {
    vi.mocked(live.deps.store.recordEvent).mockRejectedValueOnce(
      new Error("db down"),
    );
    expect((await deliver(event)).status).toBe(500);
  });

  it("is off without a secret and in demo mode", async () => {
    delete process.env.IVORA_WEBHOOK_SECRET;
    expect((await deliver(event)).status).toBe(503);
    process.env.IVORA_WEBHOOK_SECRET = SECRET;
    process.env.DEMO_MODE = "true";
    expect((await deliver(event)).status).toBe(404);
    expect(live.deps.store.recordEvent).not.toHaveBeenCalled();
  });
});

describe("webhook registration script", () => {
  it("registers only a public https endpoint at the kit's path", async () => {
    const m = (await import("../scripts/ivora-webhook.mjs" as string)) as {
      endpointUrl: (a?: string, app?: string) => string | null;
      registrationKey: (url: string, existing: number) => string;
      EVENTS: string[];
    };
    const { WEBHOOK_EVENTS } = await import("@/lib/server/live/service");
    expect(m.EVENTS).toEqual([...WEBHOOK_EVENTS]);
    expect(m.endpointUrl(undefined, "https://ops.example.com/")).toBe(
      "https://ops.example.com/api/webhooks/ivora",
    );
    for (const bad of [
      "http://ops.example.com/api/webhooks/ivora",
      "https://ops.example.com:8443/api/webhooks/ivora",
      "https://localhost/api/webhooks/ivora",
      "https://10.0.0.1/api/webhooks/ivora",
      "https://ops.example.com/other",
      "https://user:pw@ops.example.com/api/webhooks/ivora",
    ])
      expect(m.endpointUrl(bad)).toBeNull();
    expect(m.endpointUrl()).toBeNull();
    const url = "https://ops.example.com/api/webhooks/ivora";
    const k = m.registrationKey(url, 0);
    expect(k).toMatch(/^cpo-webhook-[0-9a-f]{24}-create-1$/);
    // A retry reuses the key; registering again after a disable gets a new one.
    expect(m.registrationKey(url, 0)).toBe(k);
    expect(m.registrationKey(url, 1)).not.toBe(k);
  });
});
