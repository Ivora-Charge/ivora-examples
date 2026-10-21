import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/roles";
import {
  createDemoChargerStore,
  decodeDemoChargers,
  encodeDemoChargers,
  memoryDemoChargers,
} from "@/lib/server/chargers/demo";
import { PASSWORD_PATTERN } from "@/lib/server/chargers/password";
import {
  addCharger,
  checkTest,
  editCharger,
  finishAdding,
  HEARTBEAT_FRESH_SECONDS,
  loadChargers,
  prepareStickers,
  removeCharger,
  resetPassword,
  startTest,
  stopTest,
  testConnection,
  TEST_TOKEN,
  type ChargerDeps,
} from "@/lib/server/chargers/service";
import { ChargerError } from "@/lib/server/chargers/types";
import { createDemoClient, memoryDemoFleet } from "@/lib/server/ivora/demo";
import { createLiveClient } from "@/lib/server/ivora/live";
import type { Station, Transaction } from "@/lib/server/ivora/types";
import type { Staff } from "@/lib/server/team/types";
import { isStickerCode } from "@/lib/sticker-codes";

// The charger rules run against the in-memory demo store and either the live client
// with a fake fetch (the Ivora API mocked at the HTTP boundary) or the demo client.
// No network, no real credentials.

const OPERATOR = "10000000-0000-4000-8000-0000000000aa";
const staff = (role: Role): Staff => ({
  userId: `00000000-0000-4000-8000-00000000000${role.length}`,
  email: `${role}@example.com`,
  role,
  operatorId: OPERATOR,
  operatorName: "Sample Operator",
  demo: false,
});
const owner = staff("owner");
const technician = staff("technician");
const viewer = staff("viewer");

const T0 = Date.parse("2026-10-21T12:00:00Z");

type Call = {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, unknown> | null;
};
type Reply = { status?: number; body?: unknown; headers?: HeadersInit };

/**
 * A small fake of the Ivora API. `override` answers first (for errors); otherwise it
 * keeps locations, stations and transactions like the API does.
 */
function fakeIvora() {
  const calls: Call[] = [];
  const locations = [{ id: 5, name: "Depot", external_reference: null }];
  const stations: Station[] = [];
  const transactions: Transaction[] = [];
  const s = {
    calls,
    stations,
    transactions,
    clock: T0,
    override: null as null | ((c: Call) => Reply | undefined),
  };
  const routes = (c: Call): Reply => {
    const m = c.path.match(/^\/v1\/tenants\/42\/([^?]*)/);
    const p = m?.[1] ?? "";
    if (c.method === "GET" && p === "locations")
      return { body: { data: locations, next_cursor: null } };
    if (c.method === "POST" && p === "locations") {
      const l = { id: 6, ...(c.body as object) };
      locations.push(l as never);
      return { status: 201, body: l };
    }
    if (c.method === "GET" && p === "stations") {
      const ref = new URL(`https://x${c.path}`).searchParams.get(
        "external_reference",
      );
      return {
        body: {
          data: stations.filter((x) => !ref || x.external_reference === ref),
          next_cursor: null,
        },
      };
    }
    if (c.method === "POST" && p === "stations") {
      const b = c.body as {
        name: string;
        location_id: number;
        connectors: number;
        external_reference: string;
      };
      const st: Station = {
        id: 70 + stations.length,
        name: b.name,
        online: false,
        location_id: b.location_id,
        external_reference: b.external_reference,
        connection_url: `wss://ocpp.example.test/${b.name}`,
        username: b.name,
        connectors: Array.from({ length: b.connectors }, (_, i) => ({
          id: 700 + i,
          number: i + 1,
          status: "Unavailable",
        })),
      };
      stations.push(st);
      return { status: 201, body: st };
    }
    const st = p.match(/^stations\/(\d+)(\/.*)?$/);
    if (st) {
      const station = stations.find((x) => x.id === Number(st[1]));
      if (!station)
        return {
          status: 404,
          body: { error: { code: "station_not_found", message: "m" } },
        };
      if (c.method === "GET" && !st[2]) return { body: station };
      if (c.method === "PATCH") {
        Object.assign(station, c.body);
        return {
          status: 202,
          body: { id: "op_edit", status: "succeeded", result: null },
        };
      }
      if (c.method === "DELETE") {
        stations.splice(stations.indexOf(station), 1);
        return { body: { id: station.id, deleted: true } };
      }
      if (st[2] === "/credentials")
        return {
          status: 202,
          body: {
            id: "op_cred",
            status: "succeeded",
            result: { applied: "stored" },
          },
        };
      if (st[2] === "/commands") {
        const b = c.body as {
          action: string;
          connector_id?: number;
          transaction_id?: number;
          token?: string;
        };
        if (b.action === "start")
          transactions.push({
            id: 900 + transactions.length,
            station_id: station.id,
            connector_id: b.connector_id!,
            // The API shows the last 4 characters only.
            id_token: `****${b.token!.slice(-4)}`,
            active: true,
            started_at: new Date(s.clock).toISOString(),
            ended_at: null,
            energy_wh: 0,
          });
        else {
          const t = transactions.find((x) => x.id === b.transaction_id)!;
          t.active = false;
          t.ended_at = new Date(s.clock).toISOString();
          t.energy_wh = 120;
        }
        return {
          status: 202,
          body: {
            id: "op_cmd",
            status: "succeeded",
            result: { charger_status: "Accepted" },
          },
        };
      }
    }
    if (c.method === "GET" && p.startsWith("transactions/"))
      return { body: transactions.find((x) => `transactions/${x.id}` === p) };
    if (c.method === "GET" && p === "transactions")
      return { body: { data: transactions, next_cursor: null } };
    if (c.method === "GET" && p.startsWith("operations/"))
      return { body: { id: p.slice(11), status: "succeeded", result: null } };
    throw new Error(`unexpected ${c.method} ${c.path}`);
  };
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const call: Call = {
        method: init?.method ?? "GET",
        path: u.pathname + u.search,
        key: new Headers(init?.headers).get("idempotency-key"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const r = s.override?.(call) ?? routes(call);
      return Response.json(r.body ?? {}, {
        status: r.status ?? 200,
        headers: r.headers,
      });
    },
  );
  const ivora = createLiveClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key-not-real",
    tenantId: "42",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { ...s, ivora, fetch, state: s };
}

function liveDeps() {
  const api = fakeIvora();
  const cookie = memoryDemoChargers();
  const d: ChargerDeps = {
    store: createDemoChargerStore(cookie),
    ivora: api.ivora,
    now: () => api.state.clock,
    sleep: async () => {},
  };
  return { d, api, cookie };
}

const ADD = {
  name: "CPO-DEPOT-01",
  label: "Bay 1",
  connectors: "2",
  site: "new",
  newSite: { name: "North Depot", address: "1 Example Road", country: "usa" },
};

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

/** The charger connects; its connectors are free. */
function goOnline(api: ReturnType<typeof fakeIvora>) {
  api.stations[0].online = true;
  for (const c of api.stations[0].connectors) c.status = "Available";
}

describe("chargers (live API mocked)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.IVORA_API_KEY = "test-key-not-real";
    process.env.IVORA_TENANT_ID = "42";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
    delete process.env.DEMO_MODE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("adds a site, a station and a password, each with a key from our own record", async () => {
    const { d, api, cookie } = liveDeps();
    const r = await addCharger(d, technician, ADD);
    const id = r.charger.id;
    const [loc, st, cred] = writes(api.calls);
    expect(loc).toMatchObject({
      method: "POST",
      path: "/v1/tenants/42/locations",
      key: `cpo-site-${id}-create`,
      body: {
        name: "North Depot",
        country: "USA",
        external_reference: `cpo-site-${id}`,
      },
    });
    expect(st).toMatchObject({
      method: "POST",
      path: "/v1/tenants/42/stations",
      key: `cpo-charger-${id}-create`,
      body: {
        name: "CPO-DEPOT-01",
        location_id: 6,
        connectors: 2,
        external_reference: `cpo-charger-${id}`,
      },
    });
    expect(cred).toMatchObject({
      method: "PUT",
      path: "/v1/tenants/42/stations/70/credentials",
      key: `cpo-credentials-${id}-set-1`,
    });
    // A random password within the API's pattern, returned once and never stored.
    expect(r.password).toMatch(PASSWORD_PATTERN);
    expect(cred.body).toEqual({ password: r.password });
    expect(JSON.stringify(cookie.state)).not.toContain(r.password!);
    expect(r.connectionUrl).toBe("wss://ocpp.example.test/CPO-DEPOT-01");
    expect(r.charger).toMatchObject({
      stationId: 70,
      locationId: 6,
      // Kept as the note that this record created the site.
      newSite: { name: "North Depot" },
    });
    expect(r.charger.passwordSetAt).not.toBeNull();
  });

  it("keeps an uncertain add pending and finishes it with the same keys", async () => {
    const { d, api } = liveDeps();
    let lost = true;
    api.state.override = (c) => {
      if (c.method === "POST" && c.path.endsWith("/stations") && lost)
        return {
          status: 503,
          body: { error: { code: "outcome_unknown", message: "m" } },
        };
    };
    const e = await addCharger(d, technician, ADD).catch((x) => x);
    expect(e).toMatchObject({ code: "outcome_unknown" });
    const [pending] = await d.store.list(OPERATOR);
    expect(pending).toMatchObject({
      stationId: null,
      locationId: 6,
      removedAt: null,
    });
    const list = await loadChargers(d, technician);
    expect(
      list.ok && list.chargers.find((c) => c.recordId === pending.id),
    ).toMatchObject({
      pending: true,
    });

    lost = false;
    const r = await finishAdding(d, technician, pending.id);
    expect(r.password).toMatch(PASSWORD_PATTERN);
    const keys = writes(api.calls).map((c) => c.key);
    // The site once; the station only ever with its one key.
    expect(
      keys.filter((k) => k === `cpo-site-${pending.id}-create`),
    ).toHaveLength(1);
    expect(new Set(keys.filter((k) => k?.startsWith("cpo-charger-")))).toEqual(
      new Set([`cpo-charger-${pending.id}-create`]),
    );
  });

  it("drops a record whose station the API refused outright", async () => {
    const { d, api } = liveDeps();
    api.state.override = (c) =>
      c.method === "POST" && c.path.endsWith("/stations")
        ? {
            status: 409,
            body: { error: { code: "station_name_taken", message: "m" } },
          }
        : undefined;
    await expect(
      addCharger(d, technician, { ...ADD, site: "5" }),
    ).rejects.toMatchObject({ code: "station_name_taken" });
    const [r] = await d.store.list(OPERATOR);
    expect(r.removedAt).not.toBeNull();
    // Refused once, never retried.
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("drops a record whose new site the API refused outright", async () => {
    const { d, api } = liveDeps();
    api.state.override = (c) =>
      c.method === "POST" && c.path.endsWith("/locations")
        ? {
            status: 422,
            body: { error: { code: "validation_error", message: "m" } },
          }
        : undefined;
    await expect(addCharger(d, technician, ADD)).rejects.toMatchObject({
      code: "validation_error",
    });
    const [r] = await d.store.list(OPERATOR);
    expect(r.removedAt).not.toBeNull();
    expect(api.calls.some((c) => c.path.endsWith("/stations"))).toBe(false);
  });

  it("explains a connected OCPP 1.6 charger and credential rate limits", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    api.state.override = (c) =>
      c.path.endsWith("/credentials")
        ? {
            status: 409,
            body: { error: { code: "station_online", message: "m" } },
          }
        : undefined;
    const online = await resetPassword(d, technician, charger.id).catch(
      (e) => e,
    );
    expect(online).toBeInstanceOf(ChargerError);
    expect(online.message).toMatch(/OCPP 1\.6.*Disconnect it/);

    const before = api.calls.length;
    api.state.override = (c) =>
      c.path.endsWith("/credentials")
        ? {
            status: 429,
            body: { error: { code: "credentials_rate_limited", message: "m" } },
            headers: { "Retry-After": "1800" },
          }
        : undefined;
    const limited = await resetPassword(d, technician, charger.id).catch(
      (e) => e,
    );
    expect(limited.message).toMatch(/Try again in 30 minutes/);
    // A long wait goes back to staff: no retry inside the request.
    expect(
      api.calls.slice(before).filter((c) => c.path.endsWith("/credentials")),
    ).toHaveLength(1);

    api.state.override = (c) =>
      c.path.endsWith("/credentials")
        ? {
            status: 502,
            body: { error: { code: "password_unconfirmed", message: "m" } },
          }
        : undefined;
    const n = api.calls.length;
    await expect(
      resetPassword(d, technician, charger.id),
    ).rejects.toMatchObject({
      code: "password_unconfirmed",
    });
    expect(api.calls.length - n).toBe(1);

    // Each try was a new password, with a new key.
    const keys = api.calls
      .filter((c) => c.path.endsWith("/credentials"))
      .map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("runs the connection test from the station's own state", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    const before = writes(api.calls).length;
    let t = await testConnection(d, technician, charger.id);
    expect(t).toMatchObject({
      online: false,
      booted: false,
      heartbeat: false,
      passed: false,
    });
    Object.assign(api.stations[0], {
      online: true,
      vendor: "Sample Vendor",
      last_seen: new Date(T0 - 30_000).toISOString(),
    });
    t = await testConnection(d, technician, charger.id);
    expect(t.passed).toBe(true);
    api.stations[0].last_seen = new Date(
      T0 - (HEARTBEAT_FRESH_SECONDS + 1) * 1000,
    ).toISOString();
    t = await testConnection(d, technician, charger.id);
    expect(t).toMatchObject({
      online: true,
      booted: true,
      heartbeat: false,
      passed: false,
    });
    // Reads only: nothing was sent to the charger.
    expect(writes(api.calls)).toHaveLength(before);
  });

  it("starts and stops a test session only once confirmed", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    goOnline(api);
    await expect(
      startTest(d, technician, charger.id, {
        connector: "2",
        confirmed: false,
      }),
    ).rejects.toThrow(/this starts the charger/);
    expect(api.calls.some((c) => c.path.endsWith("/commands"))).toBe(false);

    let t = await startTest(d, technician, charger.id, {
      connector: "2",
      confirmed: true,
    });
    const start = api.calls.find((c) => c.path.endsWith("/commands"))!;
    expect(start).toMatchObject({
      key: `cpo-charger-${charger.id}-test-1-start`,
      body: {
        action: "start",
        connector_id: 701,
        token: TEST_TOKEN,
        token_type: "Central",
      },
    });
    expect(t).toMatchObject({
      phase: "charging",
      transactionId: 900,
      connectorNumber: 2,
    });
    await expect(
      startTest(d, technician, charger.id, { connector: "1", confirmed: true }),
    ).rejects.toMatchObject({ code: "busy" });

    t = await stopTest(d, technician, charger.id);
    const stop = api.calls.filter((c) => c.path.endsWith("/commands"))[1];
    expect(stop).toMatchObject({
      key: `cpo-charger-${charger.id}-test-1-stop`,
      body: { action: "stop", transaction_id: 900 },
    });
    expect(t).toMatchObject({ phase: "passed", energyWh: 120 });
    await expect(checkTest(d, technician, charger.id)).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  it.each([
    [
      "503 outcome_unknown",
      {
        status: 503,
        body: { error: { code: "outcome_unknown", message: "m" } },
      },
    ],
    [
      "409 request_in_progress",
      {
        status: 409,
        body: { error: { code: "request_in_progress", message: "m" } },
      },
    ],
    ["a lost connection", "network"],
  ] as const)(
    "keeps an uncertain start (%s) open, finds its session and stops it",
    async (_name, reply) => {
      const { d, api } = liveDeps();
      const { charger } = await addCharger(d, technician, {
        ...ADD,
        site: "5",
      });
      goOnline(api);
      // The start reaches the charger, but its answer is lost.
      let reached = false;
      api.state.override = (c) => {
        if (!c.path.endsWith("/commands")) return;
        if (!reached) {
          reached = true;
          api.transactions.push({
            id: 950,
            station_id: 70,
            connector_id: 700,
            id_token: "****TEST",
            active: true,
            started_at: new Date(api.state.clock + 1_000).toISOString(),
            ended_at: null,
            energy_wh: 0,
          });
        }
        if (reply === "network") throw new TypeError("fetch failed");
        return reply;
      };
      let t = await startTest(d, technician, charger.id, {
        connector: "1",
        confirmed: true,
      });
      // Found straight away by the check the start ends with.
      expect(t).toMatchObject({
        phase: "charging",
        transactionId: 950,
        error: null,
      });
      // No second start while it runs, under any key.
      await expect(
        startTest(d, technician, charger.id, {
          connector: "2",
          confirmed: true,
        }),
      ).rejects.toMatchObject({ code: "busy" });
      const starts = () =>
        api.calls.filter(
          (c) => c.path.endsWith("/commands") && c.body?.action === "start",
        );
      expect(new Set(starts().map((c) => c.key))).toEqual(
        new Set([`cpo-charger-${charger.id}-test-1-start`]),
      );

      api.state.override = null;
      t = await stopTest(d, technician, charger.id);
      expect(api.calls.find((c) => c.body?.action === "stop")).toMatchObject({
        body: { action: "stop", transaction_id: 950 },
      });
      expect(t.phase).toBe("passed");
    },
  );

  it("keeps an uncertain start open until its session appears or it times out", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    goOnline(api);
    api.state.override = (c) =>
      c.path.endsWith("/commands")
        ? {
            status: 503,
            body: { error: { code: "outcome_unknown", message: "m" } },
          }
        : undefined;
    let t = await startTest(d, technician, charger.id, {
      connector: "1",
      confirmed: true,
    });
    expect(t.phase).toBe("starting");
    expect(t.error).toMatch(/may have started/);
    // Stop has nothing to stop yet, and sends nothing.
    await expect(stopTest(d, technician, charger.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    api.state.override = null;
    api.state.clock += 3 * 60_000;
    t = await checkTest(d, technician, charger.id);
    expect(t.phase).toBe("failed");
    expect(api.calls.filter((c) => c.body?.action === "stop")).toHaveLength(0);
  });

  it("fails a test the API refused outright, and a new one gets a new key", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    goOnline(api);
    api.state.override = (c) =>
      c.path.endsWith("/commands")
        ? {
            status: 409,
            body: { error: { code: "station_offline", message: "m" } },
          }
        : undefined;
    const t = await startTest(d, technician, charger.id, {
      connector: "1",
      confirmed: true,
    });
    expect(t).toMatchObject({ phase: "failed", attempt: 1 });
    api.state.override = null;
    const again = await startTest(d, technician, charger.id, {
      connector: "1",
      confirmed: true,
    });
    expect(again).toMatchObject({ phase: "charging", attempt: 2 });
    expect(
      api.calls.filter((c) => c.path.endsWith("/commands")).map((c) => c.key),
    ).toEqual([
      `cpo-charger-${charger.id}-test-1-start`,
      `cpo-charger-${charger.id}-test-2-start`,
    ]);
  });

  it("never adopts or stops a driver's session", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    goOnline(api);
    const driver = (id: number, connector: number | null, at: number) => ({
      id,
      station_id: 70,
      connector_id: connector,
      id_token: "****B2C3",
      active: true,
      started_at: new Date(at).toISOString(),
      ended_at: null,
      energy_wh: 4_000,
    });

    // A connector in use is never started on.
    api.stations[0].connectors[0].status = "Charging";
    api.transactions.push(driver(960, 700, T0 - 60_000));
    await expect(
      startTest(d, technician, charger.id, { connector: "1", confirmed: true }),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(api.calls.some((c) => c.path.endsWith("/commands"))).toBe(false);

    // The start on a free connector is lost, and meanwhile a driver starts a session
    // on the same connector (and one without a connector), after the request.
    api.stations[0].connectors[0].status = "Available";
    api.transactions.length = 0;
    api.state.override = (c) =>
      c.path.endsWith("/commands")
        ? {
            status: 503,
            body: { error: { code: "outcome_unknown", message: "m" } },
          }
        : undefined;
    let t = await startTest(d, technician, charger.id, {
      connector: "1",
      confirmed: true,
    });
    api.state.override = null;
    api.transactions.push(
      driver(961, 700, T0 + 2_000),
      driver(962, null, T0 + 3_000),
      // A test-token session from before this test is not this test's either.
      { ...driver(963, 700, T0 - 1_000), id_token: "****TEST" },
    );
    t = await checkTest(d, technician, charger.id);
    expect(t).toMatchObject({ phase: "starting", transactionId: null });
    await expect(stopTest(d, technician, charger.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    api.state.clock += 3 * 60_000;
    t = await checkTest(d, technician, charger.id);
    expect(t).toMatchObject({ phase: "failed", transactionId: null });
    expect(api.calls.filter((c) => c.body?.action === "stop")).toHaveLength(0);
  });

  it("sends one start when two arrive at the same moment", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    goOnline(api);
    const start = () =>
      startTest(d, technician, charger.id, { connector: "1", confirmed: true });
    const results = await Promise.allSettled([start(), start()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost && lost.reason).toMatchObject({ code: "busy" });
    expect(api.calls.filter((c) => c.path.endsWith("/commands"))).toHaveLength(
      1,
    );
  });

  it("keeps the new site's ID when the station is refused, and reuses it", async () => {
    const { d, api } = liveDeps();
    let refuse = true;
    api.state.override = (c) =>
      refuse && c.method === "POST" && c.path.endsWith("/stations")
        ? {
            status: 422,
            body: { error: { code: "validation_error", message: "m" } },
          }
        : undefined;
    const e = await addCharger(d, technician, ADD).catch((x) => x);
    expect(e).toBeInstanceOf(ChargerError);
    expect(e.message).toMatch(/North Depot" was created in Ivora and stays/);
    const [r] = await d.store.list(OPERATOR);
    expect(r).toMatchObject({
      removedAt: null,
      stationId: null,
      locationId: 6,
    });

    refuse = false;
    const done = await finishAdding(d, technician, r.id);
    expect(done.charger).toMatchObject({ stationId: 70, locationId: 6 });
    expect(
      api.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/locations"),
      ),
    ).toHaveLength(1);
  });

  it("keeps viewers read-only and lets only managers remove registered chargers", async () => {
    const { d, api } = liveDeps();
    await expect(addCharger(d, viewer, ADD)).rejects.toMatchObject({
      code: "not_allowed",
    });
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    await expect(testConnection(d, viewer, charger.id)).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(
      startTest(d, viewer, charger.id, { connector: "1", confirmed: true }),
    ).rejects.toMatchObject({ code: "not_allowed" });
    await expect(
      removeCharger(d, technician, charger.id, true),
    ).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(
      removeCharger(d, owner, charger.id, false),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("removes a charger, keeping one with history in Ivora, and retires its stickers", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    const coded = await prepareStickers(d, technician, charger.id);
    expect(coded.codes).toHaveLength(2);
    expect(coded.codes.every((c) => isStickerCode(c.code))).toBe(true);
    // Codes are stable: preparing again changes nothing.
    expect((await prepareStickers(d, technician, charger.id)).codes).toEqual(
      coded.codes,
    );

    api.state.override = (c) =>
      c.method === "DELETE"
        ? {
            status: 409,
            body: { error: { code: "station_has_history", message: "m" } },
          }
        : undefined;
    expect(await removeCharger(d, owner, charger.id, true)).toEqual({
      deletedInIvora: false,
    });
    expect(api.calls.find((c) => c.method === "DELETE")).toMatchObject({
      path: "/v1/tenants/42/stations/70",
      key: `cpo-charger-${charger.id}-delete`,
    });
    // Ivora keeps the station; the kit hides it, and its stickers say so.
    const list = await loadChargers(d, owner);
    expect(list.ok && list.chargers).toEqual([]);
    expect(await d.store.resolveCode(coded.codes[0].code)).toMatchObject({
      inService: false,
    });
  });

  it("moves a charger to another site with an edit key, and refuses bad input", async () => {
    const { d, api } = liveDeps();
    const { charger } = await addCharger(d, technician, { ...ADD, site: "5" });
    await editCharger(d, technician, charger.id, {
      label: "Bay 9",
      locationId: "6",
    });
    expect(api.calls.find((c) => c.method === "PATCH")).toMatchObject({
      path: "/v1/tenants/42/stations/70",
      key: `cpo-charger-${charger.id}-move-1`,
      body: { location_id: 6 },
    });
    const [r] = await d.store.list(OPERATOR);
    expect(r).toMatchObject({ label: "Bay 9", locationId: 6 });
    await expect(
      editCharger(d, technician, charger.id, { label: "<b>", locationId: "6" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      addCharger(d, technician, { ...ADD, name: "a b" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("takes over a station added outside the kit for tests and stickers", async () => {
    const { d, api } = liveDeps();
    api.stations.push({
      id: 80,
      name: "ELSEWHERE-1",
      online: true,
      vendor: "V",
      last_seen: new Date(T0).toISOString(),
      location_id: 5,
      connectors: [{ id: 801, number: 1 }],
    });
    const t = await testConnection(d, technician, "station-80");
    expect(t.passed).toBe(true);
    const [r] = await d.store.list(OPERATOR);
    expect(r).toMatchObject({ stationId: 80, name: "ELSEWHERE-1" });
    const list = await loadChargers(d, technician);
    expect(list.ok && list.chargers.map((c) => c.key)).toEqual([r.id]);
  });
});

describe("chargers in demo mode", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of ["IVORA_API_KEY", "IVORA_TENANT_ID", "SUPABASE_URL"])
      delete process.env[k];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("demo mode must not call fetch");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("adds, connects, tests, prints and removes a charger with no network", async () => {
    let now = T0;
    const fleet = memoryDemoFleet();
    const d: ChargerDeps = {
      store: createDemoChargerStore(memoryDemoChargers()),
      ivora: createDemoClient(fleet, () => now),
      now: () => now,
      sleep: async () => {},
    };
    const added = await addCharger(d, technician, ADD);
    expect(added.password).toMatch(PASSWORD_PATTERN);
    expect(JSON.stringify(fleet.state)).not.toContain(added.password!);
    expect(added.connectionUrl).toMatch(/^wss:\/\/ocpp\.demo\.example\//);
    const id = added.charger.id;

    // Not connected yet; the simulated charger connects and boots a few seconds later.
    expect((await testConnection(d, technician, id)).passed).toBe(false);
    now += 5_000;
    expect((await testConnection(d, technician, id)).passed).toBe(true);

    // A connected OCPP 1.6 charger's password can't be changed remotely.
    await expect(resetPassword(d, technician, id)).rejects.toThrow(/OCPP 1\.6/);

    await startTest(d, technician, id, { connector: "1", confirmed: true });
    now += 60_000;
    const done = await stopTest(d, technician, id);
    expect(done.phase).toBe("passed");
    expect(done.energyWh).toBe(123); // 7.4 kW for a minute

    const coded = await prepareStickers(d, technician, id);
    expect(coded.codes).toHaveLength(2);
    expect(await d.store.resolveCode(coded.codes[1].code)).toMatchObject({
      inService: true,
      connectorNumber: 2,
      chargerName: "Bay 1",
    });

    // It has charging history now, so the demo "Ivora" keeps it.
    expect(await removeCharger(d, owner, id, true)).toEqual({
      deletedInIvora: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deletes a sample charger that never charged, and refuses one with history", async () => {
    const d: ChargerDeps = {
      store: createDemoChargerStore(memoryDemoChargers()),
      ivora: createDemoClient(memoryDemoFleet()),
    };
    expect(await removeCharger(d, owner, "station-9103", true)).toEqual({
      deletedInIvora: true,
    });
    expect(await removeCharger(d, owner, "station-9101", true)).toEqual({
      deletedInIvora: false,
    });
    const list = await loadChargers(d, owner);
    expect(list.ok && list.chargers.map((c) => c.name)).toEqual([
      "DEMO-HARBOUR-02",
    ]);
  });

  it("keeps the demo cookie small and ignores tampering", async () => {
    const cookie = memoryDemoChargers();
    const store = createDemoChargerStore(cookie);
    const raw = encodeDemoChargers(cookie.state);
    expect(decodeDemoChargers(raw)).toEqual(cookie.state);
    expect(decodeDemoChargers("not-base64!")).toEqual({ v: 1, records: [] });
    // Full records still fit in a cookie, or are refused with a message.
    let made = 0;
    for (let i = 0; i < 10; i++)
      await store
        .create(technician, {
          name: `DEMO-FILL-${i}`,
          label: "x".repeat(80),
          locationId: 9001,
          newSite: null,
          connectors: 8,
          stationId: 9600 + i,
          connectionUrl: `wss://ocpp.demo.example/DEMO-FILL-${i}`,
        })
        .then(() => made++)
        .catch((e) => {
          expect(e).toBeInstanceOf(ChargerError);
        });
    expect(made).toBeGreaterThanOrEqual(7);
    expect(encodeDemoChargers(cookie.state).length).toBeLessThanOrEqual(3_800);
  });
});
