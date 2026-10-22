import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/roles";
import { createLiveClient } from "@/lib/server/ivora/live";
import type {
  Fault,
  Location,
  Station,
  TokenRecord,
  Transaction,
} from "@/lib/server/ivora/types";
import {
  createDemoLiveStore,
  decodeDemoLive,
  encodeDemoLive,
  memoryDemoLive,
} from "@/lib/server/live/demo";
import {
  handleEvent,
  isStaffSession,
  loadLive,
  loadStation,
  observe,
  recheckCommand,
  resendCommand,
  sendCommand,
  STAFF_TOKEN_LABEL,
  staffTokenReference,
  type LiveDeps,
} from "@/lib/server/live/service";
import { LiveError, type LiveCommand } from "@/lib/server/live/types";
import type { Staff } from "@/lib/server/team/types";

// The Live view's rules run against the in-memory demo command store and the live
// client with a fake fetch (the Ivora API mocked at the HTTP boundary). No network, no
// real credentials.

const OPERATOR = "10000000-0000-4000-8000-0000000000aa";
const staff = (role: Role): Staff => ({
  userId: `00000000-0000-4000-8000-00000000000${role.length}`,
  email: `${role}@example.com`,
  role,
  operatorId: OPERATOR,
  operatorName: "Sample Operator",
  demo: false,
});
const technician = staff("technician");
const manager = staff("manager");
const viewer = staff("viewer");

const T0 = Date.parse("2026-10-21T12:00:00Z");
let reqN = 0;
const rid = () => `40000000-0000-4000-8000-${String(++reqN).padStart(12, "0")}`;

type Call = {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, unknown> | null;
};
type Reply = { status?: number; body?: unknown };
type Op = {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
};

function fakeIvora() {
  const calls: Call[] = [];
  const locations: Location[] = [
    { id: 5, name: "Depot", latitude: 51.5, longitude: -0.12 },
    { id: 6, name: "Yard", latitude: null, longitude: null },
  ];
  const fault: Fault = {
    id: "f1",
    station_id: 71,
    connector_id: 712,
    open: true,
    error_code: "GroundFailure",
    info: null,
    ocpp_status: "Faulted",
    opened_at: "2026-10-21T11:00:00Z",
    cleared_at: null,
  };
  const stations: Station[] = [
    {
      id: 70,
      name: "DEPOT-01",
      online: true,
      location_id: 5,
      last_seen: "2026-10-21T11:59:00Z",
      connectors: [
        { id: 701, number: 1, status: "Charging", max_power_w: 22_000 },
        { id: 702, number: 2, status: "Available", max_power_w: 22_000 },
      ],
      open_faults: [],
    },
    {
      id: 71,
      name: "DEPOT-02",
      online: true,
      location_id: 5,
      connectors: [
        { id: 711, number: 1, status: "Preparing" },
        { id: 712, number: 2, status: "Faulted" },
      ],
      open_faults: [fault],
    },
    {
      id: 72,
      name: "YARD-01",
      online: false,
      location_id: 6,
      connectors: [{ id: 721, number: 1, status: "Available" }],
    },
  ];
  const transactions: Transaction[] = [
    {
      id: 900,
      station_id: 70,
      connector_id: 701,
      id_token: "****B2C3",
      active: true,
      started_at: "2026-10-21T11:00:00Z",
      ended_at: null,
      energy_wh: 12_400,
    },
    {
      id: 899,
      station_id: 70,
      connector_id: 702,
      active: false,
      started_at: "2026-10-21T08:00:00Z",
      ended_at: "2026-10-21T09:00:00Z",
      energy_wh: 30_000,
    },
  ];
  const ops = new Map<string, Op>();
  const tokens: TokenRecord[] = [];
  const s = {
    calls,
    stations,
    transactions,
    ops,
    tokens,
    clock: T0,
    /** What the next command's operation looks like. */
    answer: {
      status: "succeeded",
      result: { charger_status: "Accepted" },
    } as Omit<Op, "id">,
    override: null as null | ((c: Call) => Reply | undefined),
  };
  const routes = (c: Call): Reply => {
    const m = c.path.match(/^\/v1\/tenants\/42\/([^?]*)/);
    const p = m?.[1] ?? "";
    const q = new URL(`https://x${c.path}`).searchParams;
    if (c.method === "GET" && p === "locations")
      return { body: { data: locations, next_cursor: null } };
    if (c.method === "GET" && p === "stations")
      return { body: { data: stations, next_cursor: null } };
    if (c.method === "GET" && p === "transactions") {
      const st = q.get("station_id");
      return {
        body: {
          data: transactions.filter((t) => !st || t.station_id === Number(st)),
          next_cursor: null,
        },
      };
    }
    if (c.method === "GET" && p === "tokens")
      return {
        body: {
          data: tokens.filter(
            (t) => t.external_reference === q.get("external_reference"),
          ),
          next_cursor: null,
        },
      };
    if (c.method === "POST" && p === "tokens") {
      const b = c.body as Omit<TokenRecord, "id">;
      if (tokens.some((t) => t.external_reference === b.external_reference))
        return {
          status: 409,
          body: { error: { code: "external_reference_taken", message: "m" } },
        };
      const t = { id: 300 + tokens.length, ...b };
      tokens.push(t);
      return { status: 201, body: t };
    }
    if (c.method === "GET" && p.startsWith("operations/")) {
      const op = ops.get(decodeURIComponent(p.slice(11)));
      return op
        ? { body: op }
        : {
            status: 404,
            body: { error: { code: "operation_not_found", message: "m" } },
          };
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
      if (c.method === "GET" && st[2] === "/faults")
        return {
          body: {
            data: [
              ...(station.open_faults ?? []),
              {
                ...fault,
                id: "f0",
                open: false,
                cleared_at: "2026-10-20T10:00:00Z",
              },
            ],
            next_cursor: null,
          },
        };
      if (c.method === "POST" && st[2] === "/commands") {
        // The API answers a repeated key with the original operation.
        const existing = [...ops.values()].find((o) => o.id === `op-${c.key}`);
        if (existing) return { status: 202, body: existing };
        const op = { id: `op-${c.key}`, ...structuredClone(s.answer) };
        ops.set(op.id, op);
        return { status: 202, body: op };
      }
    }
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
      return Response.json(r.body ?? {}, { status: r.status ?? 200 });
    },
  );
  const ivora = createLiveClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key-not-real",
    tenantId: "42",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { ...s, state: s, ivora };
}

function deps() {
  const api = fakeIvora();
  const cookie = memoryDemoLive();
  const d: LiveDeps = {
    store: createDemoLiveStore(cookie),
    ivora: api.ivora,
    now: () => api.state.clock,
    sleep: async () => {},
  };
  return { d, api, cookie };
}

const commands = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/commands"));
const tokenCalls = (calls: Call[]) =>
  calls.filter((c) => /\/tokens(\?|$)/.test(c.path));

/** Moves the test clock and the wall clock (the demo store stamps commands with it). */
function advance(api: { state: { clock: number } }, ms: number) {
  api.state.clock += ms;
  vi.setSystemTime(api.state.clock);
}

describe("live view (live API mocked)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.IVORA_API_KEY = "test-key-not-real";
    process.env.IVORA_TENANT_ID = "42";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
    delete process.env.DEMO_MODE;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.useRealTimers();
  });

  it("shows sites, chargers, connector status, sessions, faults and map points", async () => {
    const { d, api } = deps();
    const r = await loadLive(d, viewer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const live = r.live;
    expect(live.counts).toEqual({
      stations: 3,
      online: 2,
      offline: 1,
      faulted: 1,
      charging: 1,
      connectors: 5,
    });
    expect(live.sites.map((s) => s.name)).toEqual(["Depot", "Yard"]);
    const depot = live.sites[0].stations;
    expect(depot.map((s) => [s.name, s.state])).toEqual([
      ["DEPOT-01", "online"],
      ["DEPOT-02", "faulted"],
    ]);
    expect(depot[0].connectors[0]).toMatchObject({
      status: "Charging",
      maxPowerKw: 22,
      session: { id: 900, energyKwh: 12.4 },
    });
    // An offline charger's connectors read Offline, whatever they last reported.
    expect(live.sites[1].stations[0].connectors[0].status).toBe("Offline");
    expect(live.sessions.map((s) => s.id)).toEqual([900]);
    expect(live.faults).toMatchObject([
      {
        id: "f1",
        stationName: "DEPOT-02",
        connectorNumber: 2,
        errorCode: "GroundFailure",
      },
    ]);
    // Only sites with coordinates go on the map, with their worst state.
    expect(live.points).toEqual([
      expect.objectContaining({
        id: 5,
        lat: 51.5,
        lng: -0.12,
        state: "faulted",
        online: 1,
        faulted: 1,
      }),
    ]);
    // Reads only.
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("reads one charger's faults from GET /faults", async () => {
    const { d, api } = deps();
    const r = await loadStation(d, viewer, 71);
    expect(r.ok && r.detail?.faults.map((f) => [f.id, f.open])).toEqual([
      ["f1", true],
      ["f0", false],
    ]);
    expect(
      api.calls.some((c) =>
        c.path.startsWith("/v1/tenants/42/stations/71/faults?limit=20"),
      ),
    ).toBe(true);
    expect(await loadStation(d, viewer, 99)).toEqual({
      ok: true,
      detail: null,
    });
  });

  it("sends a remote start with the operator's registered staff token, and observes the session", async () => {
    const { d, api } = deps();
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "start",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    // The staff token is registered once in the operator's Ivora token list, with a key
    // and an external reference derived from the operator.
    const [lookup, created] = tokenCalls(api.calls);
    expect(lookup).toMatchObject({
      method: "GET",
      path: `/v1/tenants/42/tokens?limit=1&external_reference=${staffTokenReference(OPERATOR)}`,
    });
    expect(created).toMatchObject({
      method: "POST",
      key: `cpo-staff-token-${OPERATOR}-create`,
      body: {
        type: "Central",
        status: "Accepted",
        label: STAFF_TOKEN_LABEL,
        external_reference: `cpo-staff-${OPERATOR}`,
      },
    });
    const token = api.tokens[0].id_token;
    expect(token).toMatch(/^STAFF[A-Z0-9]{15}$/);
    const [sent] = commands(api.calls);
    expect(sent).toMatchObject({
      path: "/v1/tenants/42/stations/70/commands",
      key: `cpo-command-${c.id}-start`,
      body: {
        action: "start",
        connector_id: 702,
        token,
        token_type: "Central",
      },
    });
    expect(c).toMatchObject({ phase: "accepted", chargerStatus: "Accepted" });
    // Accepted is not assumed to mean charging: the view looks for the session.
    const s = api.stations[0];
    expect(observe(c, s, api.transactions, T0 + 10_000, token)).toMatch(
      /Waiting for the session/,
    );
    expect(observe(c, s, api.transactions, T0 + 4 * 60_000, token)).toMatch(
      /No session started/,
    );
    const tx = (id: number, idToken: string) => ({
      id,
      station_id: 70,
      connector_id: 702,
      id_token: idToken,
      active: true,
      started_at: new Date(T0 + 3_000).toISOString(),
      ended_at: null,
    });
    // A driver's own session on that connector is not this command's result.
    expect(observe(c, s, [tx(902, "****B2C3")], T0 + 10_000, token)).toMatch(
      /Waiting for the session/,
    );
    // The API masks the token to its last 4 characters.
    const staffTx = tx(901, `****${token.slice(-4)}`);
    expect(isStaffSession(staffTx, token)).toBe(true);
    expect(observe(c, s, [staffTx], T0 + 10_000, token)).toBe(
      "Session 901 started.",
    );
    // The view labels it as a staff session.
    api.transactions.push(staffTx);
    const r = await loadLive(d, viewer);
    expect(r.ok && r.live.sessions.map((x) => [x.id, x.staff]).sort()).toEqual([
      [900, false],
      [901, true],
    ]);
    // A session with the operator's free charging token is labelled free, not staff.
    await d.store.putFreeToken(OPERATOR, {
      idToken: "FREEABCDEFGHJKLMN234",
      tokenId: 77,
    });
    api.transactions.push(tx(903, "****N234"));
    const f = await loadLive(d, viewer);
    expect(
      f.ok && f.live.sessions.map((x) => [x.id, x.staff, x.free]).sort(),
    ).toEqual([
      [900, false, false],
      [901, true, false],
      [903, false, true],
    ]);
    api.transactions.pop();
    // Registered once: the next start reuses the stored token without asking Ivora.
    const before = tokenCalls(api.calls).length;
    api.transactions.pop();
    api.stations[0].connectors[1].status = "Available";
    advance(api, 60_000);
    await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 71,
      action: "start",
      connectorId: 711,
      confirmed: true,
      sessions: [],
    }).catch(() => undefined);
    api.stations[1].connectors[0].status = "Available";
    await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 71,
      action: "start",
      connectorId: 711,
      confirmed: true,
      sessions: [],
    });
    expect(tokenCalls(api.calls)).toHaveLength(before);
    expect(commands(api.calls).at(-1)?.body).toMatchObject({ token });
  });

  it("adopts a staff token already in Ivora, and refuses a blocked one", async () => {
    const { d, api } = deps();
    api.tokens.push({
      id: 77,
      id_token: "STAFFEXISTING0001",
      status: "Blocked",
      label: STAFF_TOKEN_LABEL,
      external_reference: staffTokenReference(OPERATOR),
    });
    const input = {
      stationId: 70,
      action: "start",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    };
    await expect(
      sendCommand(d, technician, { ...input, requestId: rid() }),
    ).rejects.toThrow(/is Blocked/);
    expect(commands(api.calls)).toHaveLength(0);
    api.tokens[0].status = "Accepted";
    await sendCommand(d, technician, { ...input, requestId: rid() });
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path.endsWith("tokens")),
    ).toHaveLength(0);
    expect(commands(api.calls)[0].body).toMatchObject({
      token: "STAFFEXISTING0001",
    });
    expect(await d.store.getStaffToken(OPERATOR)).toEqual({
      idToken: "STAFFEXISTING0001",
      tokenId: 77,
    });
  });

  it("starts only on a free (Available) connector, never one a driver plugged into", async () => {
    const { d, api } = deps();
    for (const [stationId, connectorId] of [
      [70, 701], // charging
      [71, 711], // Preparing: a driver plugged in and pays as usual
      [71, 712], // faulted
    ]) {
      const e = await sendCommand(d, technician, {
        requestId: rid(),
        stationId,
        action: "start",
        connectorId,
        confirmed: true,
        sessions: [],
      }).catch((x) => x);
      expect(e).toBeInstanceOf(LiveError);
      expect(e.code).toBe("not_ready");
    }
    await expect(
      sendCommand(d, technician, {
        requestId: rid(),
        stationId: 72,
        action: "start",
        connectorId: 721,
        confirmed: true,
        sessions: [],
      }),
    ).rejects.toThrow(/offline/);
    const ok = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "start",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    expect(ok.phase).toBe("accepted");
    expect(commands(api.calls)).toHaveLength(1);
  });

  it("never stops, resets or unlocks a driver's session without naming it", async () => {
    const { d, api } = deps();
    const base = { stationId: 70, confirmed: true } as const;
    // Stop needs the session confirmed by name.
    await expect(
      sendCommand(d, technician, {
        ...base,
        requestId: rid(),
        action: "stop",
        transactionId: 900,
        sessions: [],
      }),
    ).rejects.toMatchObject({ code: "confirm" });
    // Reset and unlock would end it too.
    await expect(
      sendCommand(d, technician, {
        ...base,
        requestId: rid(),
        action: "reset",
        mode: "soft",
        sessions: [],
      }),
    ).rejects.toThrow(/ends session 900 on connector 1/);
    await expect(
      sendCommand(d, technician, {
        ...base,
        requestId: rid(),
        action: "unlock",
        connectorId: 701,
        sessions: [],
      }),
    ).rejects.toMatchObject({ code: "confirm" });
    // Confirming another session does not count.
    await expect(
      sendCommand(d, technician, {
        ...base,
        requestId: rid(),
        action: "reset",
        mode: "hard",
        sessions: [899],
      }),
    ).rejects.toMatchObject({ code: "confirm" });
    // Unlocking a free connector needs no session.
    await sendCommand(d, technician, {
      ...base,
      requestId: rid(),
      action: "unlock",
      connectorId: 702,
      sessions: [],
    });
    expect(commands(api.calls).map((c) => c.body)).toEqual([
      { action: "unlock", connector_id: 702 },
    ]);
    const stop = await sendCommand(d, technician, {
      ...base,
      requestId: rid(),
      action: "stop",
      transactionId: 900,
      sessions: ["900"],
    });
    expect(stop.confirmedSessions).toEqual([900]);
    expect(commands(api.calls).at(-1)).toMatchObject({
      key: `cpo-command-${stop.id}-stop`,
      body: { action: "stop", transaction_id: 900 },
    });
    // The session still runs until the charger reports it ended.
    expect(observe(stop, api.stations[0], api.transactions, T0, null)).toMatch(
      /Waiting for the charger to end session 900/,
    );
    api.transactions[0].active = false;
    expect(observe(stop, api.stations[0], api.transactions, T0, null)).toBe(
      "Session 900 ended.",
    );
  });

  it("refuses a reset when a session started after the confirmation was opened", async () => {
    const { d, api } = deps();
    api.transactions.push({
      id: 905,
      station_id: 70,
      connector_id: 702,
      active: true,
      started_at: new Date(T0).toISOString(),
      ended_at: null,
    });
    const e = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "reset",
      mode: "soft",
      confirmed: true,
      sessions: [900],
    }).catch((x) => x);
    expect(e).toMatchObject({ code: "confirm" });
    expect(e.message).toMatch(/session 905 on connector 2/);
    expect(e.message).not.toMatch(/session 900/);
    expect(commands(api.calls)).toHaveLength(0);
    // Named: sent, with a soft or hard mode.
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "reset",
      mode: "hard",
      confirmed: true,
      sessions: [900, 905],
    });
    expect(commands(api.calls)[0].body).toEqual({
      action: "reset",
      mode: "hard",
    });
    expect(c.confirmedSessions.sort()).toEqual([900, 905]);
  });

  it("keeps viewers read-only and needs the confirmation tick", async () => {
    const { d, api } = deps();
    const input = {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    };
    await expect(sendCommand(d, viewer, input)).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(recheckCommand(d, viewer, "x")).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(
      sendCommand(d, technician, { ...input, confirmed: false }),
    ).rejects.toThrow(/Tick the box/);
    await expect(
      sendCommand(d, technician, { ...input, requestId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      sendCommand(d, technician, { ...input, action: "update_firmware" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(api.calls).toHaveLength(0);
  });

  it("sends one command for a double click, and none while another is pending", async () => {
    const { d, api } = deps();
    api.state.answer = { status: "dispatching", result: null };
    const requestId = rid();
    const input = {
      requestId,
      stationId: 70,
      action: "reset",
      mode: "soft",
      confirmed: true,
      sessions: [900],
    };
    const [a, b] = await Promise.all([
      sendCommand(d, technician, input),
      sendCommand(d, manager, input),
    ]);
    expect(a.id).toBe(b.id);
    // The second submission only reads the command the first made: exactly one POST.
    expect(commands(api.calls)).toHaveLength(1);
    expect(commands(api.calls)[0].key).toBe(`cpo-command-${a.id}-reset`);
    // Even while the first send has not reached Ivora yet.
    const late = await sendCommand(d, technician, input);
    expect(late.id).toBe(a.id);
    expect(commands(api.calls)).toHaveLength(1);
    await expect(
      sendCommand(d, manager, { ...input, requestId: rid(), mode: "hard" }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(commands(api.calls)).toHaveLength(1);
  });

  it("a double click while the first send is unconfirmed sends nothing more", async () => {
    const { d, api } = deps();
    api.state.override = (c) =>
      c.method === "POST"
        ? {
            status: 503,
            body: { error: { code: "outcome_unknown", message: "m" } },
          }
        : undefined;
    const input = {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    };
    const first = await sendCommand(d, technician, input);
    const posts = commands(api.calls).length;
    const again = await sendCommand(d, technician, input);
    expect(again).toMatchObject({ id: first.id, phase: "pending" });
    expect(commands(api.calls)).toHaveLength(posts);
  });

  it("checking again only reads; sending again is separate, same key, within a minute", async () => {
    const { d, api } = deps();
    let lost = true;
    api.state.override = (c) => {
      if (c.method === "POST" && lost)
        return {
          status: 503,
          body: { error: { code: "outcome_unknown", message: "m" } },
        };
    };
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    expect(c).toMatchObject({ phase: "pending", operationId: null });
    expect(c.error).toMatch(/same idempotency key/);
    const keys = () => commands(api.calls).map((x) => x.key);
    const posts = keys().length;
    lost = false;
    // Check again: no operation to read, so nothing happens and nothing is sent.
    expect(await recheckCommand(d, technician, c.id)).toMatchObject({
      phase: "pending",
    });
    expect(keys()).toHaveLength(posts);
    const r = await loadStation(d, viewer, 70);
    expect(r.ok && r.detail?.pending?.resendUntil).toBe(
      new Date(T0 + 60_000).toISOString(),
    );
    // Send again: the same key, after the sessions are read again.
    advance(api, 30_000);
    const again = await resendCommand(d, technician, c.id);
    expect(again).toMatchObject({ phase: "accepted", error: null });
    expect(new Set(keys())).toEqual(new Set([`cpo-command-${c.id}-unlock`]));
    expect(keys()).toHaveLength(posts + 1);
    // Viewers can do neither.
    await expect(resendCommand(d, viewer, c.id)).rejects.toMatchObject({
      code: "not_allowed",
    });
  });

  it("closes an unconfirmed command as unknown after a minute, without sending", async () => {
    const { d, api } = deps();
    const lose = () =>
      (api.state.override = (c) =>
        c.method === "POST"
          ? {
              status: 503,
              body: { error: { code: "outcome_unknown", message: "m" } },
            }
          : undefined);
    lose();
    const input = {
      stationId: 70,
      action: "reset",
      mode: "hard",
      confirmed: true,
      sessions: [900],
    };
    const a = await sendCommand(d, technician, { ...input, requestId: rid() });
    const posts = commands(api.calls).length;
    api.state.override = null;
    advance(api, 61_000);
    // Send again is refused: it closes as unknown instead.
    const late = await resendCommand(d, technician, a.id);
    expect(late.phase).toBe("unknown");
    expect(late.error).toMatch(/more than a minute/);
    expect(commands(api.calls)).toHaveLength(posts);
    expect((await loadLive(d, viewer)).ok).toBe(true);

    // Check again does the same for the next one, an hour later: never a resend.
    lose();
    const b = await sendCommand(d, technician, { ...input, requestId: rid() });
    // The client's own retries of the first send, all with the same key.
    const sent = commands(api.calls).length;
    api.state.override = null;
    advance(api, 60 * 60_000);
    const checked = await recheckCommand(d, technician, b.id);
    expect(checked.phase).toBe("unknown");
    expect(commands(api.calls)).toHaveLength(sent);
    expect(
      new Set(
        commands(api.calls)
          .filter((x) => x.key?.includes(b.id))
          .map((x) => x.key),
      ).size,
    ).toBe(1);
  });

  it("never sends a reset again once a session it would end started since the confirmation", async () => {
    const { d, api } = deps();
    api.state.override = (c) =>
      c.method === "POST"
        ? {
            status: 503,
            body: { error: { code: "outcome_unknown", message: "m" } },
          }
        : undefined;
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "reset",
      mode: "hard",
      confirmed: true,
      sessions: [900],
    });
    const posts = commands(api.calls).length;
    api.state.override = null;
    // A driver plugs in on connector 2 within the minute.
    api.transactions.push({
      id: 906,
      station_id: 70,
      connector_id: 702,
      id_token: "****D4E5",
      active: true,
      started_at: new Date(T0 + 20_000).toISOString(),
      ended_at: null,
    });
    advance(api, 20_000);
    const again = await resendCommand(d, technician, c.id);
    expect(again.phase).toBe("unknown");
    expect(again.error).toMatch(/session 906 on connector 2/);
    expect(commands(api.calls)).toHaveLength(posts);
  });

  it("closes a command still dispatching after 15 minutes as unknown on a check", async () => {
    const { d, api } = deps();
    api.state.answer = { status: "dispatching", result: null };
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    advance(api, 5 * 60_000);
    expect((await recheckCommand(d, technician, c.id)).phase).toBe("pending");
    advance(api, 11 * 60_000);
    const late = await recheckCommand(d, technician, c.id);
    expect(late.phase).toBe("unknown");
    // A command that reached Ivora is never sent again: Send again only reads it.
    expect((await resendCommand(d, technician, c.id)).phase).toBe("unknown");
    expect(commands(api.calls)).toHaveLength(1);
  });

  it("passes Ivora's Retry-After to the page after a 429", async () => {
    const { d, api } = deps();
    api.state.override = (c) =>
      c.path.includes("/locations")
        ? {
            status: 429,
            body: { error: { code: "rate_limited", message: "m" } },
          }
        : undefined;
    const r = await loadLive(d, viewer);
    expect(r).toMatchObject({ ok: false, retryAfter: 60 });
  });

  it("fails only on a definite refusal", async () => {
    const { d, api } = deps();
    api.state.override = (c) => {
      if (c.method === "POST")
        return {
          status: 409,
          body: {
            error: {
              code: "station_offline",
              message: "The station is offline",
            },
          },
        };
    };
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    expect(c.phase).toBe("failed");
    expect(c.error).toMatch(/station_offline/);
    // Final: a re-check sends nothing.
    await recheckCommand(d, technician, c.id);
    expect(commands(api.calls)).toHaveLength(1);
  });

  it("follows the operation: dispatching, then the charger's answer or an unknown outcome", async () => {
    const { d, api } = deps();
    api.state.answer = { status: "dispatching", result: null };
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    expect(c).toMatchObject({
      phase: "pending",
      operationId: `op-cpo-command-${c.id}-unlock`,
    });
    // A re-check reads the operation; it does not post again.
    api.ops.get(c.operationId!)!.status = "succeeded";
    api.ops.get(c.operationId!)!.result = { charger_status: "UnlockFailed" };
    const failed = await recheckCommand(d, technician, c.id);
    expect(failed).toMatchObject({
      phase: "failed",
      chargerStatus: "UnlockFailed",
    });
    expect(commands(api.calls)).toHaveLength(1);

    const u = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 71,
      action: "unlock",
      connectorId: 711,
      confirmed: true,
      sessions: [],
    });
    api.ops.get(u.operationId!)!.status = "unknown";
    const unknown = await recheckCommand(d, technician, u.id);
    expect(unknown.phase).toBe("unknown");
    expect(unknown.error).toMatch(/could not confirm/);
    // Unknown is final: never resent, with this key or a new one.
    await recheckCommand(d, technician, u.id);
    expect(commands(api.calls)).toHaveLength(2);
  });

  it("records a rejected operation with Ivora's code", async () => {
    const { d, api } = deps();
    api.state.answer = {
      status: "rejected",
      result: {
        error: { code: "connector_not_found", message: "No such connector" },
      },
    };
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    expect(c).toMatchObject({ phase: "failed" });
    expect(c.error).toMatch(/connector_not_found/);
  });

  it("lets a page load pick up an answer, re-reading only the operation", async () => {
    const { d, api } = deps();
    api.state.answer = { status: "dispatching", result: null };
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    api.ops.get(c.operationId!)!.status = "succeeded";
    api.ops.get(c.operationId!)!.result = { charger_status: "Unlocked" };
    const before = commands(api.calls).length;
    const r = await loadLive(d, viewer);
    expect(r.ok && r.live.commands[0]).toMatchObject({
      phase: "accepted",
      observed: "Connector unlocked.",
      stationName: "DEPOT-01",
      connectorNumber: 2,
    });
    expect(commands(api.calls)).toHaveLength(before);
  });

  it("records an operation.completed webhook from a fresh read of the operation", async () => {
    const { d, api } = deps();
    api.state.answer = { status: "dispatching", result: null };
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "unlock",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    const op = api.ops.get(c.operationId!)!;
    op.status = "succeeded";
    op.result = { charger_status: "Unlocked" };
    // The payload is only a cue: it claims rejected, but the API says succeeded.
    await handleEvent(d, {
      id: "evt_1",
      type: "operation.completed",
      tenant_id: 42,
      data: {
        operation: { id: op.id, status: "rejected" },
        scope: "station.command",
      },
    });
    expect((await d.store.getCommand(OPERATOR, c.id))?.phase).toBe("accepted");
    // An operation the kit did not send is ignored.
    await handleEvent(d, {
      id: "evt_2",
      type: "operation.completed",
      tenant_id: 42,
      data: { operation: { id: "op_other" } },
    });
    expect(api.calls.some((x) => x.path.includes("op_other"))).toBe(false);
  });

  it("keeps the demo command cookie small and ignores tampering", async () => {
    const cookie = memoryDemoLive();
    const store = createDemoLiveStore(cookie);
    for (let i = 0; i < 12; i++) {
      const { command } = await store.claim(technician, {
        requestId: rid(),
        stationId: 100 + i,
        action: "reset",
        connectorId: null,
        transactionId: null,
        mode: "soft",
        confirmedSessions: [],
      });
      await store.record(OPERATOR, command.id, {
        phase: "accepted",
        error: "x".repeat(900),
      });
    }
    expect(encodeDemoLive(cookie.state).length).toBeLessThan(3_800);
    expect(decodeDemoLive("garbage").commands).toEqual([]);
    const forged = deflateRawSync(
      JSON.stringify({ v: 1, commands: [{ id: "x", phase: "done" }] }),
    ).toString("base64url");
    expect(decodeDemoLive(forged).commands).toEqual([]);
    const list: LiveCommand[] = await store.listCommands(OPERATOR);
    expect(list.every((c) => (c.error ?? "").length <= 600)).toBe(true);
  });
});
