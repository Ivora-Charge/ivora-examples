import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/roles";
import { createLiveClient } from "@/lib/server/ivora/live";
import type {
  Fault,
  Location,
  Station,
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
  loadLive,
  loadStation,
  observe,
  recheckCommand,
  sendCommand,
  STAFF_TOKEN,
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
  const s = {
    calls,
    stations,
    transactions,
    ops,
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

describe("live view (live API mocked)", () => {
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

  it("sends a remote start with a key from its own record, and observes the session", async () => {
    const { d, api } = deps();
    const c = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 70,
      action: "start",
      connectorId: 702,
      confirmed: true,
      sessions: [],
    });
    const [sent] = commands(api.calls);
    expect(sent).toMatchObject({
      path: "/v1/tenants/42/stations/70/commands",
      key: `cpo-command-${c.id}-start`,
      body: {
        action: "start",
        connector_id: 702,
        token: STAFF_TOKEN,
        token_type: "Central",
      },
    });
    expect(c).toMatchObject({ phase: "accepted", chargerStatus: "Accepted" });
    // Accepted is not assumed to mean charging: the view looks for the session.
    const s = api.stations[0];
    // The demo store stamps commands with the wall clock; observe at the test's.
    c.requestedAt = new Date(T0).toISOString();
    expect(observe(c, s, api.transactions, T0 + 10_000)).toMatch(
      /Waiting for the session/,
    );
    expect(observe(c, s, api.transactions, T0 + 4 * 60_000)).toMatch(
      /No session started/,
    );
    const tx = {
      id: 901,
      station_id: 70,
      connector_id: 702,
      active: true,
      started_at: new Date(T0 + 3_000).toISOString(),
      ended_at: null,
    };
    expect(observe(c, s, [tx], T0 + 10_000)).toBe("Session 901 started.");
  });

  it("starts only on a free connector or one with a vehicle waiting", async () => {
    const { d, api } = deps();
    for (const [stationId, connectorId] of [
      [70, 701], // charging
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
    // A vehicle waiting (Preparing) is the remote start's main use.
    const ok = await sendCommand(d, technician, {
      requestId: rid(),
      stationId: 71,
      action: "start",
      connectorId: 711,
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
    stop.requestedAt = new Date(T0).toISOString();
    expect(observe(stop, api.stations[0], api.transactions, T0)).toMatch(
      /Waiting for the charger to end session 900/,
    );
    api.transactions[0].active = false;
    expect(observe(stop, api.stations[0], api.transactions, T0)).toBe(
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
    // The second submission re-reads the first's operation; it never sends again
    // with a new key.
    expect(new Set(commands(api.calls).map((c) => c.key))).toEqual(
      new Set([`cpo-command-${a.id}-reset`]),
    );
    await expect(
      sendCommand(d, manager, { ...input, requestId: rid(), mode: "hard" }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(new Set(commands(api.calls).map((c) => c.key)).size).toBe(1);
  });

  it("keeps an uncertain send pending and re-checks it with the same key", async () => {
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
    expect(new Set(keys())).toEqual(new Set([`cpo-command-${c.id}-unlock`]));
    lost = false;
    const again = await recheckCommand(d, technician, c.id);
    expect(again).toMatchObject({ phase: "accepted", error: null });
    expect(new Set(keys())).toEqual(new Set([`cpo-command-${c.id}-unlock`]));
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
