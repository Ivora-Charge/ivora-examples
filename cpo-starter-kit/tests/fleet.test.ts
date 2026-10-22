import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/roles";
import { AccessDeniedError } from "@/lib/server/auth";
import { resetIvoraForTests } from "@/lib/server/ivora";
import { createLiveClient } from "@/lib/server/ivora/live";
import type {
  IvoraClient,
  Station,
  TokenRecord,
  Transaction,
  TransactionListItem,
} from "@/lib/server/ivora/types";
import {
  cardKey,
  formatLabel,
  maskedKey,
  parseCardsCsv,
  parseLabel,
} from "@/lib/server/fleet/input";
import {
  addCard,
  applyImport,
  cardReference,
  checkImport,
  loadCard,
  loadCards,
  updateCard,
  type FleetDeps,
} from "@/lib/server/fleet/service";
import { FleetError, type CardLedger } from "@/lib/server/fleet/types";
import type { LedgerSession } from "@/lib/server/fleet/types";
import {
  refreshCardSessions,
  RESCAN_MS,
  toLedger,
} from "@/lib/server/fleet/usage";
import type { TrackedSession } from "@/lib/server/live/types";
import { createDemoLedger } from "@/lib/server/fleet/demo";
import type { Staff } from "@/lib/server/team/types";

// Cards run against the live client over a fake fetch (routed by method and path), so
// the API contract (Idempotency-Key on every write, the import's dry run and its
// no-retry rule, PATCH bodies) is covered with no network or credentials. The card
// ledger is an in-memory fake; its SQL is tested in tests/database.test.ts.

const API_KEY = "test-api-key";
const NOW = Date.parse("2026-10-22T15:00:00Z");
const DAY = 86_400_000;

function staff(role: Role): Staff {
  return {
    userId: `00000000-0000-4000-8000-00000000000${role.length}`,
    email: `${role}@example.com`,
    role,
    operatorId: "10000000-0000-4000-8000-0000000000aa",
    operatorName: "Sample Operator",
    demo: false,
  };
}
const owner = staff("owner");
const manager = staff("manager");
const technician = staff("technician");
const viewer = staff("viewer");

const STAMP = "2026-10-01T10:00:00Z";
const token = (
  id: number,
  value: string,
  o: Partial<TokenRecord> = {},
): TokenRecord => ({
  id,
  id_token: value,
  type: "ISO14443",
  status: "Accepted",
  expires_at: null,
  label: null,
  external_reference: null,
  ocpp16_compatible: value.length <= 20,
  created_at: STAMP,
  updated_at: STAMP,
  ...o,
});

const TOKENS: TokenRecord[] = [
  token(1, "04A1B2C3D4E5", { label: "Driver: Sam Sample" }),
  token(2, "04FF00110022", { label: "Vehicle: Van 12", status: "Blocked" }),
  token(3, "AA99BEEF", { label: "Old system label" }),
  token(4, "04000000AAAA", {
    label: "Driver: Ada Example",
    expires_at: "2026-10-01T00:00:00Z",
  }),
  // The kit's own staff and free charging tokens: listed by Ivora, never cards.
  token(5, "STAFFX1234567890", {
    type: "Central",
    label: "Staff remote start (CPO kit)",
    external_reference: "cpo-staff-op",
  }),
  token(6, "FREEZZ00000022", {
    type: "Central",
    label: "Free charging (CPO kit)",
    external_reference: "cpo-free-op",
  }),
];

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}
type Route = (call: Call) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const apiError = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
) =>
  json(status, {
    error: { code, message: code, details },
    request_id: "req_1",
  });

const listed = (data: TokenRecord[]) => () =>
  json(200, { data, next_cursor: null });

function fakeApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const call: Call = {
        method: init?.method ?? "GET",
        path: u.pathname.replace("/v1/tenants/42/", ""),
        query: u.searchParams,
        headers: new Headers(init?.headers as Record<string, string>),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      if (!route) throw new Error(`unexpected ${call.method} ${call.path}`);
      return route(call);
    },
  );
  const ivora = createLiveClient({
    baseUrl: "https://api.example.test",
    apiKey: API_KEY,
    tenantId: "42",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { calls, ivora };
}

type MemoryLedger = CardLedger & {
  rows: Map<number, LedgerSession & { checkedAt: number; failures?: number }>;
  marks: Map<number, { mark: number; scannedAt: number | null }>;
};

function memoryLedger(now = () => NOW): MemoryLedger {
  const rows = new Map<
    number,
    LedgerSession & { checkedAt: number; failures?: number }
  >();
  const marks = new Map<number, { mark: number; scannedAt: number | null }>();
  const inPeriod = (s: LedgerSession, since: number, until: number) => {
    const at = s.startedAt ? Date.parse(s.startedAt) : NaN;
    return at >= since && at < until;
  };
  return {
    mode: "live",
    rows,
    marks,
    async usage(since, until) {
      const by = new Map<
        string,
        { key: string; sessions: number; running: number; energyWh: number }
      >();
      for (const s of rows.values()) {
        if (!inPeriod(s, since, until)) continue;
        const u = by.get(s.key) ?? {
          key: s.key,
          sessions: 0,
          running: 0,
          energyWh: 0,
        };
        u.sessions++;
        if (s.active) u.running++;
        u.energyWh += s.energyWh ?? 0;
        by.set(s.key, u);
      }
      return [...by.values()];
    },
    async sessions(key, since, until, limit) {
      return [...rows.values()]
        .filter((s) => s.key === key && inPeriod(s, since, until))
        .sort((a, b) => Date.parse(b.startedAt!) - Date.parse(a.startedAt!))
        .slice(0, limit);
    },
    async getTransactionMark(id) {
      return marks.get(id)?.mark ?? null;
    },
    async advanceTransactionMark(id, tx, scanned = false) {
      const m = marks.get(id) ?? { mark: 0, scannedAt: null };
      m.mark = Math.max(m.mark, tx);
      if (scanned) m.scannedAt = now();
      marks.set(id, m);
    },
    async scannedAt() {
      return new Map(
        [...marks]
          .filter(([, m]) => m.scannedAt !== null)
          .map(([id, m]) => [id, m.scannedAt!]),
      );
    },
    async record(s) {
      const old = rows.get(s.transactionId);
      if (old && !old.active) return;
      rows.set(s.transactionId, {
        ...s,
        energyWh: Math.max(s.energyWh ?? 0, old?.energyWh ?? 0),
        checkedAt: now(),
      });
    },
    async forget(id) {
      rows.delete(id);
    },
    // As cpo_defer_card_session: 2, 4, 8 ... minutes later, at most 6 hours.
    async defer(id) {
      const s = rows.get(id);
      if (!s?.active) return;
      s.failures = Math.min((s.failures ?? 0) + 1, 30);
      s.checkedAt = now() + Math.min(2 ** s.failures, 360) * 60_000;
    },
    async due(before, limit) {
      return [...rows.values()]
        .filter((s) => s.active && s.checkedAt < before)
        .sort((a, b) => a.checkedAt - b.checkedAt)
        .slice(0, limit)
        .map((s) => ({
          transactionId: s.transactionId,
          stationId: s.stationId,
        }));
    },
  };
}

const session = (
  id: number,
  key: string,
  daysAgo: number,
  energyWh: number,
  active = false,
): LedgerSession => ({
  transactionId: id,
  stationId: 5,
  connectorNumber: 1,
  key,
  startedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  endedAt: active
    ? null
    : new Date(NOW - daysAgo * DAY + 3_600_000).toISOString(),
  energyWh,
  active,
});

function deps(
  ivora: IvoraClient,
  o: { ledger?: CardLedger; enabled?: boolean } = {},
): FleetDeps {
  return {
    ivora,
    ledger: o.ledger ?? memoryLedger(),
    pricing: {
      load: async () => ({
        tariffs: [],
        stations: [
          {
            stationId: 5,
            tariffId: null,
            private: true,
            connectors: {},
            revision: 1,
          },
        ],
      }),
    },
    company: {
      load: async () =>
        ({ timeZone: "America/Chicago" }) as Awaited<
          ReturnType<FleetDeps["company"]["load"]>
        >,
    },
    enabled: o.enabled ?? true,
    now: () => NOW,
  };
}

/** A form's request ID. */
const RID = "formrequest000000001";

/**
 * Ivora's token 1 with its idempotency store: an answer is kept under its key and
 * replayed for that key (503 outcome_unknown too). A label-only change does not move
 * updated_at. `failNext` makes the next new key answer with that code, changing nothing.
 */
function statefulIvora(start: TokenRecord) {
  const s = {
    card: { ...start },
    failNext: null as null | "outcome_unknown" | "request_in_progress",
    api: null as unknown as ReturnType<typeof fakeApi>,
  };
  const answers = new Map<string, () => Response>();
  s.api = fakeApi({
    "GET tokens/1": () => json(200, s.card),
    "PATCH tokens/1": (c) => {
      const key = c.headers.get("idempotency-key")!;
      const kept = answers.get(key);
      if (kept) return kept();
      if (s.failNext) {
        const code = s.failNext;
        s.failNext = null;
        const answer = () =>
          apiError(code === "outcome_unknown" ? 503 : 409, code);
        answers.set(key, answer);
        return answer();
      }
      const body = c.body as Partial<TokenRecord>;
      const moves = body.status !== undefined || body.expires_at !== undefined;
      s.card = {
        ...s.card,
        ...body,
        updated_at: moves ? "2026-10-22T15:00:00Z" : s.card.updated_at,
      };
      const snapshot = { ...s.card };
      answers.set(key, () => json(200, snapshot));
      return json(200, snapshot);
    },
  });
  return s;
}

const LIVE_ENV = {
  IVORA_API_KEY: API_KEY,
  IVORA_TENANT_ID: "42",
  SUPABASE_URL: "https://supabase.example.test",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

describe("card input", () => {
  it("reads card,holder,name lines, with an optional header and either separator", () => {
    const r = parseCardsCsv(
      '﻿card,holder,name\r\n04A1B2C3,driver,"Sample, Sam"\n\n04FF0011;Vehicle; Van  12 \n',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { line: 2, value: "04A1B2C3", kind: "driver", name: "Sample, Sam" },
      { line: 4, value: "04FF0011", kind: "vehicle", name: "Van 12" },
    ]);
    // Without a header the first line is a card.
    expect(parseCardsCsv("04A1B2C3,driver,Sam").rows).toHaveLength(1);
  });

  it("refuses each bad line with what to fix, and keeps the good ones", () => {
    const r = parseCardsCsv(
      [
        "04A1B2C3,driver,Sam",
        "04a1b2c3,vehicle,Van",
        "has space,driver,Ann",
        "iv0123456789abcdef01,driver,Pay",
        "04A1,boss,Bea",
        "04A2,driver,",
        "04A3,driver",
        `04A4,driver,${"x".repeat(71)}`,
        "04A5,vehicle,Van 5",
      ].join("\n"),
    );
    expect(r.rows.map((x) => x.line)).toEqual([1, 9]);
    expect(r.errors).toEqual([
      { line: 2, message: "This card is already on line 1." },
      { line: 3, message: expect.stringMatching(/without spaces/) },
      { line: 4, message: expect.stringMatching(/payment tokens/) },
      { line: 5, message: 'The holder must be "driver" or "vehicle".' },
      { line: 6, message: expect.stringMatching(/Enter the driver/) },
      { line: 7, message: expect.stringMatching(/3 columns/) },
      { line: 8, message: expect.stringMatching(/at most 70/) },
    ]);
  });

  it("labels per driver or vehicle, and reads labels set elsewhere as they are", () => {
    expect(formatLabel("driver", "Sam Sample")).toBe("Driver: Sam Sample");
    expect(parseLabel("Vehicle: Van 12")).toEqual({
      kind: "vehicle",
      name: "Van 12",
    });
    expect(parseLabel("Old system label")).toEqual({
      kind: null,
      name: "Old system label",
    });
    expect(parseLabel(null)).toEqual({ kind: null, name: "" });
  });

  it("matches a session's masked token to a card by its last 4, in any case", () => {
    expect(cardKey("04a1b2c3d4e5")).toBe("D4E5");
    expect(maskedKey("****d4e5")).toBe("D4E5");
    // Ivora masks a token of 4 characters or fewer as a bare ****: no key.
    expect(maskedKey("****AB")).toBeNull();
    expect(cardKey("AB")).toBe("AB");
    expect(maskedKey(null)).toBeNull();
    expect(maskedKey("")).toBeNull();
    expect(maskedKey("****")).toBeNull();
  });
});

describe("cards against the live API", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, LIVE_ENV);
    delete process.env.DEMO_MODE;
    resetIvoraForTests();
    vi.stubGlobal("fetch", () => {
      throw new Error("tests must not reach the network");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("lets everyone see cards and only managers and owners change them, checked before any request", async () => {
    const api = fakeApi({ "GET tokens": listed(TOKENS) });
    const d = deps(api.ivora);
    for (const actor of [technician, viewer]) {
      await expect(
        addCard(d, actor, { value: "X1", kind: "driver", name: "A" }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(checkImport(d, actor, "a,driver,b")).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(
        applyImport(d, actor, "a,driver,b", "r".repeat(22)),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        updateCard(d, actor, 1, {
          intent: "block",
          revision: STAMP,
          requestId: RID,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    expect(api.calls).toHaveLength(0);
    expect((await loadCards(d, viewer)).cards).toHaveLength(4);
  });

  it("does nothing while FLEET_MODULE is off", async () => {
    const api = fakeApi({});
    const d = deps(api.ivora, { enabled: false });
    await expect(loadCards(d, owner)).rejects.toMatchObject({ code: "off" });
    await expect(
      addCard(d, owner, {
        value: "X1",
        kind: "driver",
        name: "A",
        requestId: "r".repeat(22),
      }),
    ).rejects.toMatchObject({ code: "off" });
    expect(api.calls).toHaveLength(0);
  });

  it("lists cards without the kit's own tokens, with each card's sessions and energy", async () => {
    const api = fakeApi({ "GET tokens": listed(TOKENS) });
    const ledger = memoryLedger();
    await ledger.record(session(901, "D4E5", 2, 12_000));
    await ledger.record(session(902, "D4E5", 1, 8_500, true));
    await ledger.record(session(903, "D4E5", 40, 30_000)); // before the period
    await ledger.record(session(904, "0022", 3, 5_000)); // shared last 4
    const v = await loadCards(deps(api.ivora, { ledger }), viewer, {
      days: "30",
    });
    expect(v.cards.map((c) => c.id)).toEqual([4, 3, 1, 2]);
    const sam = v.cards.find((c) => c.id === 1)!;
    expect(sam).toMatchObject({
      masked: "****D4E5",
      holder: { kind: "driver", name: "Sam Sample" },
      state: "active",
      usage: { sessions: 2, running: 1, energyWh: 20_500 },
      kit: false,
    });
    // The van's card and the free charging token both end in 0022: no figures.
    const van = v.cards.find((c) => c.id === 2)!;
    expect(van).toMatchObject({ state: "blocked", usage: null, sharedWith: 1 });
    // Accepted, but its expiry date has passed.
    expect(v.cards.find((c) => c.id === 4)!.state).toBe("expired");
    expect(v.privateChargers).toEqual([]);
    expect(v.zone).toBe("America/Chicago");
    // Never the full value: only the masked form and the last 4.
    expect(JSON.stringify(v)).not.toContain("04A1B2C3D4E5");

    const blocked = await loadCards(deps(api.ivora, { ledger }), viewer, {
      state: "blocked",
    });
    expect(blocked.cards.map((c) => c.id)).toEqual([2]);
    expect(
      (await loadCards(deps(api.ivora, { ledger }), viewer, { search: "e5" }))
        .cards,
    ).toHaveLength(1);
    expect(
      (await loadCards(deps(api.ivora, { ledger }), viewer, { search: "van" }))
        .cards[0].id,
    ).toBe(2);
  });

  it("shows no figures for a card of 4 characters or fewer, whose sessions Ivora masks as ****", async () => {
    const short = token(7, "A1B2", { label: "Driver: Short" });
    const api = fakeApi({
      "GET tokens": listed([...TOKENS, short]),
      "GET tokens/7": () => json(200, short),
    });
    const ledger = memoryLedger();
    const d = deps(api.ivora, { ledger });
    const row = (await loadCards(d, viewer)).cards.find((c) => c.id === 7)!;
    expect(row).toMatchObject({ short: true, usage: null, sharedWith: 0 });
    expect(
      (await loadCards(d, viewer)).cards.find((c) => c.id === 1),
    ).toMatchObject({ short: false });
    const one = await loadCard(d, viewer, 7);
    expect(one).toMatchObject({ usage: null, card: { short: true } });
  });

  it("names private chargers, which cards and staff start", async () => {
    const api = fakeApi({
      "GET tokens": listed(TOKENS),
      "GET stations": () =>
        json(200, {
          data: [{ id: 5, name: "SITE-DEPOT-01", connectors: [] }],
          next_cursor: null,
        }),
    });
    const v = await loadCards(deps(api.ivora), viewer);
    expect(v.privateChargers).toEqual([{ id: 5, name: "SITE-DEPOT-01" }]);
  });

  it("shows a card's sessions, and gives no total when its last 4 are shared", async () => {
    const api = fakeApi({
      "GET tokens/1": () => json(200, TOKENS[0]),
      "GET tokens/2": () => json(200, TOKENS[1]),
      "GET tokens/5": () => json(200, TOKENS[4]),
      "GET tokens/9": () => apiError(404, "token_not_found"),
      "GET tokens": listed(TOKENS),
      "GET stations": () =>
        json(200, {
          data: [{ id: 5, name: "SITE-DEPOT-01", connectors: [] }],
          next_cursor: null,
        }),
    });
    const ledger = memoryLedger();
    await ledger.record(session(901, "D4E5", 2, 12_000));
    await ledger.record(session(904, "0022", 3, 5_000));
    const d = deps(api.ivora, { ledger });
    const one = await loadCard(d, viewer, 1);
    expect(one.usage).toEqual({ sessions: 1, running: 0, energyWh: 12_000 });
    expect(one.sessions[0]).toMatchObject({
      transactionId: 901,
      stationName: "SITE-DEPOT-01",
    });
    const van = await loadCard(d, viewer, 2);
    expect(van.usage).toBeNull();
    expect(van.sharedOther).toBe(1);
    expect(van.sessions).toHaveLength(1);
    // The kit's own tokens and unknown IDs are not cards.
    await expect(loadCard(d, viewer, 5)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(loadCard(d, viewer, 9)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("adds a card with a key from the form and a reference from its value", async () => {
    const created = token(10, "04CAFE001122", {
      label: "Vehicle: Van 7",
      external_reference: cardReference("04CAFE001122"),
    });
    const api = fakeApi({
      "GET tokens": listed(TOKENS),
      "POST tokens": () => json(201, created),
    });
    const rid = "abcdefghijklmnop0123";
    const r = await addCard(deps(api.ivora), manager, {
      value: " 04CAFE001122 ",
      kind: "vehicle",
      name: " Van   7 ",
      requestId: rid,
    });
    expect(r.card).toMatchObject({ id: 10, masked: "****1122", kit: true });
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.headers.get("idempotency-key")).toBe(`cpo-card-${rid}-create`);
    expect(post.body).toEqual({
      id_token: "04CAFE001122",
      type: "ISO14443",
      status: "Accepted",
      label: "Vehicle: Van 7",
      external_reference: cardReference("04cafe001122"),
    });
    // No other token ends in 1122: no warning.
    expect(r.warnings).toEqual([]);
  });

  it("warns when a new card's last 4 are shared or it is too long for OCPP 1.6", async () => {
    const value = "LONGCARDVALUE-000000000022";
    const api = fakeApi({
      "GET tokens": listed(TOKENS),
      "POST tokens": () =>
        json(
          201,
          token(11, value, { label: "Driver: Bea", ocpp16_compatible: false }),
        ),
    });
    const r = await addCard(deps(api.ivora), owner, {
      value,
      kind: "driver",
      name: "Bea",
      requestId: "abcdefghijklmnop0123",
    });
    expect(r.warnings.join("\n")).toMatch(
      /2 other tokens in your list end in the same 4/,
    );
    expect(r.warnings.join("\n")).toMatch(/OCPP 1.6 chargers can't read it/);
  });

  it("refuses a card already in the list, or the kit's own token, before sending", async () => {
    const api = fakeApi({ "GET tokens": listed(TOKENS) });
    const d = deps(api.ivora);
    const form = {
      kind: "driver",
      name: "Sam",
      requestId: "abcdefghijklmnop0123",
    };
    await expect(
      addCard(d, manager, { ...form, value: "04a1b2c3d4e5" }),
    ).rejects.toMatchObject({ code: "exists" });
    await expect(
      addCard(d, manager, { ...form, value: "STAFFX1234567890" }),
    ).rejects.toMatchObject({ code: "kit_token" });
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("treats a repeated add of the same card as done, and Ivora's token_exists as a clear message", async () => {
    const value = "04CAFE001122";
    const existing = token(10, value, {
      label: "Driver: Sam",
      external_reference: cardReference(value),
    });
    const form = {
      value,
      kind: "driver",
      name: "Sam",
      requestId: "abcdefghijklmnop0123",
    };
    const again = fakeApi({ "GET tokens": listed([...TOKENS, existing]) });
    expect((await addCard(deps(again.ivora), manager, form)).card.id).toBe(10);
    expect(again.calls.filter((c) => c.method === "POST")).toHaveLength(0);

    const raced = fakeApi({
      "GET tokens": listed(TOKENS),
      "POST tokens": () => apiError(409, "token_exists", { token_id: 10 }),
    });
    await expect(
      addCard(deps(raced.ivora), manager, form),
    ).rejects.toMatchObject({ code: "exists" });
  });

  it("lists every problem with an add form", async () => {
    const api = fakeApi({});
    const err = await addCard(deps(api.ivora), manager, {
      value: "has space",
      kind: "boss",
      name: "",
      requestId: "short",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FleetError);
    expect([err.message, ...err.problems]).toEqual([
      expect.stringMatching(/^Card value:/),
      "Holder: choose a driver or a vehicle.",
      expect.stringMatching(/^Name:/),
      "Reload the page and try again.",
    ]);
    expect(api.calls).toHaveLength(0);
  });

  it("checks an import with Ivora's dry run: no key, values and labels only", async () => {
    const api = fakeApi({
      "GET tokens": listed(TOKENS),
      "POST tokens/import": (c) => {
        expect(c.query.get("dry_run")).toBe("true");
        return json(200, {
          dry_run: true,
          counts: { create: 1, update: 1, unchanged: 0, error: 1 },
          rows: [
            { row: 1, id_token: "04A1B2C3D4E5", action: "update", token_id: 1 },
            { row: 2, id_token: "04NEW0000001", action: "create" },
            {
              row: 3,
              id_token: "04TYPE000001",
              action: "error",
              code: "token_type_mismatch",
              message: "Type differs",
            },
          ],
        });
      },
    });
    const csv = [
      "card,holder,name",
      "04A1B2C3D4E5,driver,Sam Sample-Jones",
      "bad value,driver,X",
      "04NEW0000001,vehicle,Van 9",
      "FREEZZ00000022,driver,Nope",
      "04TYPE000001,driver,Tia",
    ].join("\n");
    const o = await checkImport(deps(api.ivora), manager, csv);
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.headers.get("idempotency-key")).toBeNull();
    expect(post.body).toEqual({
      rows: [
        { id_token: "04A1B2C3D4E5", label: "Driver: Sam Sample-Jones" },
        { id_token: "04NEW0000001", label: "Vehicle: Van 9" },
        { id_token: "04TYPE000001", label: "Driver: Tia" },
      ],
    });
    expect(o).toMatchObject({
      dryRun: true,
      sendable: 3,
      counts: { create: 1, update: 1, unchanged: 0, error: 3 },
    });
    expect(o.lines.map((l) => [l.line, l.action])).toEqual([
      [2, "update"],
      [3, "error"],
      [4, "create"],
      [5, "error"],
      [6, "error"],
    ]);
    expect(o.lines[3].message).toMatch(/kit's own staff or free/);
    expect(o.lines[4]).toMatchObject({
      masked: "****0001",
      message: "Type differs (token_type_mismatch)",
    });
  });

  it("imports with a key from the rows and the request, never retrying an uncertain import", async () => {
    let answer: () => Response = () =>
      json(200, {
        dry_run: false,
        counts: { create: 1, update: 0, unchanged: 0, error: 0 },
        rows: [
          { row: 1, id_token: "04NEW0000001", action: "create", token_id: 12 },
        ],
      });
    const api = fakeApi({
      "GET tokens": listed(TOKENS),
      "POST tokens/import": () => answer(),
    });
    const d = deps(api.ivora);
    const csv = "04NEW0000001,vehicle,Van 9";
    const rid = "abcdefghijklmnop0123";
    const o = await applyImport(d, manager, csv, rid);
    expect(o).toMatchObject({ dryRun: false, counts: { create: 1 } });
    await applyImport(d, manager, csv, rid);
    const keys = api.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.headers.get("idempotency-key"));
    expect(keys[0]).toMatch(
      /^cpo-card-import-[0-9a-f]{24}-abcdefghijklmnop0123-apply$/,
    );
    // The same file from the same form is the same import.
    expect(keys[1]).toBe(keys[0]);
    expect(
      api.calls.find((c) => c.method === "POST")!.query.get("dry_run"),
    ).toBeNull();

    answer = () => apiError(503, "outcome_unknown");
    const before = api.calls.length;
    await expect(
      applyImport(d, manager, csv, "anotherrequest0000001"),
    ).rejects.toMatchObject({ code: "uncertain" });
    // Sent once: Ivora asks for the same rows with a new key, not the same key again.
    expect(
      api.calls.slice(before).filter((c) => c.method === "POST"),
    ).toHaveLength(1);
    await expect(applyImport(d, manager, csv, "bad")).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("says an import still running at Ivora changed nothing yet", async () => {
    const api = fakeApi({
      "GET tokens": listed(TOKENS),
      "POST tokens/import": () => apiError(409, "request_in_progress"),
    });
    await expect(
      applyImport(deps(api.ivora), manager, "04NEW0000001,vehicle,Van 9", RID),
    ).rejects.toMatchObject({
      code: "uncertain",
      message: expect.stringMatching(/still running.*nothing has changed yet/),
    });
  });

  it("refuses an empty or oversized file before asking Ivora", async () => {
    const api = fakeApi({ "GET tokens": listed(TOKENS) });
    const d = deps(api.ivora);
    await expect(checkImport(d, manager, "\n\n")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      checkImport(d, manager, "x".repeat(300 * 1024)),
    ).rejects.toMatchObject({ code: "invalid" });
    const many = Array.from(
      { length: 1001 },
      (_, i) => `C${String(i).padStart(6, "0")},driver,N${i}`,
    ).join("\n");
    await expect(checkImport(d, manager, many)).rejects.toThrow(/at most 1000/);
    expect(api.calls).toHaveLength(0);
  });

  it("blocks a card with a key from the card, the action and the form's request", async () => {
    const blocked = {
      ...TOKENS[0],
      status: "Blocked",
      updated_at: "2026-10-22T15:00:00Z",
    };
    const api = fakeApi({
      "GET tokens/1": () => json(200, TOKENS[0]),
      "PATCH tokens/1": () => json(200, blocked),
    });
    const r = await updateCard(deps(api.ivora), manager, 1, {
      intent: "block",
      revision: STAMP,
      requestId: RID,
    });
    expect(r).toMatchObject({ changed: true, card: { state: "blocked" } });
    const patch = api.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ status: "Blocked" });
    expect(patch.headers.get("idempotency-key")).toMatch(
      new RegExp(`^cpo-card-1-block-[0-9a-f]{12}-${RID}$`),
    );
    // Without the form's request ID nothing is sent.
    await expect(
      updateCard(deps(api.ivora), manager, 1, {
        intent: "block",
        revision: STAMP,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("blocks after an unconfirmed try: the next submit has a new key", async () => {
    const ivora = statefulIvora(TOKENS[0]);
    ivora.failNext = "outcome_unknown";
    const d = deps(ivora.api.ivora);
    // Ivora could not confirm it, and it did not land.
    await expect(
      updateCard(d, manager, 1, {
        intent: "block",
        revision: STAMP,
        requestId: "firstsubmit000000001",
      }),
    ).rejects.toMatchObject({
      code: "uncertain",
      message: expect.stringMatching(/could not confirm this change/),
    });
    expect(ivora.card.status).toBe("Accepted");
    // The form came back with a new request ID: a new key, which Ivora carries out.
    const r = await updateCard(d, manager, 1, {
      intent: "block",
      revision: STAMP,
      requestId: "secondsubmit00000001",
    });
    expect(r).toMatchObject({ changed: true, card: { state: "blocked" } });
    expect(ivora.card.status).toBe("Blocked");
    const keys = ivora.api.calls
      .filter((c) => c.method === "PATCH")
      .map((c) => c.headers.get("idempotency-key"));
    expect(new Set(keys).size).toBe(2);
  });

  it("relabels A, then B, then A again, and the card ends at A", async () => {
    const ivora = statefulIvora({ ...TOKENS[0], label: "Driver: A" });
    const d = deps(ivora.api.ivora);
    const relabel = async (name: string, requestId: string) =>
      updateCard(d, manager, 1, {
        intent: "label",
        // A label does not move updated_at: every form names the same revision.
        revision: STAMP,
        requestId,
        kind: "driver",
        name,
      });
    await relabel("B", "relabelsubmit0000001");
    expect(ivora.card.label).toBe("Driver: B");
    const r = await relabel("A", "relabelsubmit0000002");
    expect(r.message).toBe('Card ****D4E5 is now labelled "Driver: A".');
    expect(ivora.card.label).toBe("Driver: A");
    expect(ivora.card.updated_at).toBe(STAMP);
  });

  it("says a change is still running at Ivora, not that it may be half done", async () => {
    const ivora = statefulIvora(TOKENS[0]);
    ivora.failNext = "request_in_progress";
    await expect(
      updateCard(deps(ivora.api.ivora), manager, 1, {
        intent: "block",
        revision: STAMP,
        requestId: RID,
      }),
    ).rejects.toMatchObject({
      code: "uncertain",
      message: expect.stringMatching(/still running.*nothing has changed yet/),
    });
  });

  it("refuses a change over a newer one, unless the card already is as asked", async () => {
    const changed = { ...TOKENS[1], updated_at: "2026-10-20T00:00:00Z" };
    const api = fakeApi({ "GET tokens/2": () => json(200, changed) });
    const d = deps(api.ivora);
    // Someone relabelled it since the page was loaded at STAMP.
    await expect(
      updateCard(d, manager, 2, {
        intent: "unblock",
        revision: STAMP,
        requestId: RID,
      }),
    ).rejects.toMatchObject({ code: "stale" });
    // Blocking a blocked card (a repeated submit) sends nothing.
    const again = await updateCard(d, manager, 2, {
      intent: "block",
      revision: STAMP,
      requestId: RID,
    });
    expect(again.changed).toBe(false);
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("makes a card active again, clearing an expiry date that has passed", async () => {
    const api = fakeApi({
      "GET tokens/4": () => json(200, TOKENS[3]),
      "PATCH tokens/4": (c) =>
        json(200, { ...TOKENS[3], ...(c.body as object), updated_at: "x" }),
    });
    const r = await updateCard(deps(api.ivora), manager, 4, {
      intent: "unblock",
      revision: STAMP,
      requestId: RID,
    });
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({
      status: "Accepted",
      expires_at: null,
    });
    expect(r.card.state).toBe("active");
  });

  it("sets an expiry date as the end of that day in the company's time zone", async () => {
    const api = fakeApi({
      "GET tokens/1": () => json(200, TOKENS[0]),
      "PATCH tokens/1": (c) =>
        json(200, { ...TOKENS[0], ...(c.body as object), updated_at: "x" }),
    });
    const d = deps(api.ivora);
    const r = await updateCard(d, manager, 1, {
      intent: "expiry",
      revision: STAMP,
      requestId: RID,
      date: "2026-12-31",
    });
    // Chicago is UTC-6 in winter: the card works until 2027-01-01 00:00 local.
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({
      expires_at: "2027-01-01T06:00:00.000Z",
    });
    expect(r.message).toBe(
      "Card ****D4E5 works until the end of 2026-12-31 (America/Chicago).",
    );
    for (const date of ["2026-10-21", "2026-02-30", ""])
      await expect(
        updateCard(d, manager, 1, {
          intent: "expiry",
          revision: STAMP,
          requestId: RID,
          date,
        }),
      ).rejects.toMatchObject({ code: "invalid" });
  });

  it("says a blocked card stays blocked when it gets an expiry date", async () => {
    const api = fakeApi({
      "GET tokens/2": () => json(200, TOKENS[1]),
      "PATCH tokens/2": (c) =>
        json(200, { ...TOKENS[1], ...(c.body as object), updated_at: "x" }),
    });
    const r = await updateCard(deps(api.ivora), manager, 2, {
      intent: "expiry",
      revision: STAMP,
      requestId: RID,
      date: "2026-12-31",
    });
    expect(r.message).not.toMatch(/works until/);
    expect(r.message).toMatch(
      /expiry date of the end of 2026-12-31 .* It is blocked now/,
    );
  });

  it("relabels a card for a driver or a vehicle, and never touches the kit's own tokens", async () => {
    const api = fakeApi({
      "GET tokens/3": () => json(200, TOKENS[2]),
      "GET tokens/6": () => json(200, TOKENS[5]),
      "PATCH tokens/3": (c) =>
        json(200, { ...TOKENS[2], ...(c.body as object), updated_at: "x" }),
    });
    const d = deps(api.ivora);
    const r = await updateCard(d, manager, 3, {
      intent: "label",
      revision: STAMP,
      requestId: RID,
      kind: "vehicle",
      name: "Van 3",
    });
    expect(r.card.holder).toEqual({ kind: "vehicle", name: "Van 3" });
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({
      label: "Vehicle: Van 3",
    });
    await expect(
      updateCard(d, manager, 6, {
        intent: "block",
        revision: STAMP,
        requestId: RID,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updateCard(d, manager, 3, {
        intent: "delete",
        revision: STAMP,
        requestId: RID,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("card ledger refresh", () => {
  const station = (id: number) => ({ id, name: `S${id}` }) as Station;
  const tx = (id: number, o: Partial<Transaction> = {}): Transaction => ({
    id,
    station_id: 5,
    connector_id: 51,
    connector_number: 1,
    active: false,
    id_token: "****d4e5",
    started_at: new Date(NOW - DAY).toISOString(),
    ended_at: new Date(NOW - DAY + 3_600_000).toISOString(),
    energy_wh: 10_000,
    ...o,
  });

  function fakeIvora(sessions: Transaction[]) {
    const limits: unknown[] = [];
    const ivora = {
      listAllStations: vi.fn(async (l?: unknown) => {
        limits.push(l);
        return { data: [station(5), station(6)], truncated: false };
      }),
      listTransactionsAfter: vi.fn(
        async (
          q: { station_id: number; after: number; limit?: number },
          l?: unknown,
        ) => {
          limits.push(l);
          const rows = sessions
            .filter((s) => s.station_id === q.station_id && s.id > q.after)
            .sort((a, b) => a.id - b.id);
          const data: TransactionListItem[] = rows
            .slice(0, q.limit ?? 100)
            .map((s) => ({
              id: s.id,
              station_id: s.station_id,
              active: s.active,
              started_at: s.started_at,
              ended_at: s.ended_at,
            }));
          return { data, next_cursor: data.at(-1)?.id ?? null };
        },
      ),
      getTransaction: vi.fn(async (id: number, l?: unknown) => {
        limits.push(l);
        const s = sessions.find((x) => x.id === id);
        if (!s) throw Object.assign(new Error("nf"), {});
        return s;
      }),
    };
    return { ivora, limits };
  }

  it("records each new session's card and energy, within the caller's deadline", async () => {
    const { ivora, limits } = fakeIvora([
      tx(101),
      tx(102, { id_token: null }), // no token: not a card session
      tx(103, { active: true, ended_at: null, energy_wh: 4_000 }),
      tx(201, { station_id: 6, id_token: "****0022" }),
    ]);
    const ledger = memoryLedger();
    const deadline = NOW + 5_000;
    const r = await refreshCardSessions(
      { ivora, ledger, now: () => NOW },
      { deadline },
    );
    expect(r).toMatchObject({
      stations: 2,
      reads: 4,
      recorded: 3,
      limited: false,
    });
    expect([...ledger.rows.keys()].sort()).toEqual([101, 103, 201]);
    expect(ledger.rows.get(101)).toMatchObject({
      key: "D4E5",
      energyWh: 10_000,
      active: false,
    });
    expect(ledger.rows.get(103)).toMatchObject({ active: true });
    expect(ledger.marks.get(5)).toMatchObject({ mark: 103, scannedAt: NOW });
    // Every read carries the deadline and hands a 429 back at once.
    expect(
      limits.every(
        (l) =>
          JSON.stringify(l) === JSON.stringify({ deadline, failOn429: true }),
      ),
    ).toBe(true);
    // Scanned a moment ago: not scanned again within RESCAN_MS.
    ivora.listTransactionsAfter.mockClear();
    await refreshCardSessions(
      { ivora, ledger, now: () => NOW + RESCAN_MS - 1 },
      { deadline: NOW + RESCAN_MS + 5_000 },
    );
    expect(ivora.listTransactionsAfter).not.toHaveBeenCalled();
  });

  it("reads running sessions again until they end, and forgets one Ivora no longer has", async () => {
    const sessions = [
      tx(103, { active: true, ended_at: null, energy_wh: 4_000 }),
    ];
    const { ivora } = fakeIvora(sessions);
    const ledger = memoryLedger();
    await ledger.record({
      transactionId: 103,
      stationId: 5,
      connectorNumber: 1,
      key: "D4E5",
      startedAt: sessions[0].started_at,
      endedAt: null,
      energyWh: 4_000,
      active: true,
    });
    await ledger.record({ ...ledger.rows.get(103)!, transactionId: 104 });
    ledger.rows.get(103)!.checkedAt = NOW - 10 * 60_000;
    ledger.rows.get(104)!.checkedAt = NOW - 10 * 60_000;
    sessions[0] = tx(103, { energy_wh: 9_000 });
    ivora.getTransaction.mockImplementation(async (id: number) => {
      if (id === 104) {
        const { IvoraError } = await import("@/lib/server/ivora/errors");
        throw new IvoraError(404, "transaction_not_found", "gone");
      }
      return sessions[0];
    });
    await refreshCardSessions(
      { ivora, ledger, now: () => NOW },
      { deadline: NOW + 5_000, maxStations: 0 },
    );
    expect(ledger.rows.get(103)).toMatchObject({
      active: false,
      energyWh: 9_000,
    });
    expect(ledger.rows.has(104)).toBe(false);
  });

  it("stops at Ivora's first 429", async () => {
    const { ivora } = fakeIvora([tx(101), tx(201, { station_id: 6 })]);
    const { IvoraError } = await import("@/lib/server/ivora/errors");
    ivora.getTransaction.mockRejectedValue(
      new IvoraError(429, "rate_limited", "slow down", undefined, 30),
    );
    const ledger = memoryLedger();
    const r = await refreshCardSessions(
      { ivora, ledger, now: () => NOW },
      { deadline: NOW + 5_000 },
    );
    expect(r.limited).toBe(true);
    expect(ivora.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("puts off a running session whose re-read keeps failing, so the others get its slot", async () => {
    const running = (id: number) =>
      tx(id, { active: true, ended_at: null, energy_wh: 1_000 });
    const sessions = [running(301), running(302), running(303)];
    const { ivora } = fakeIvora(sessions);
    const { IvoraError } = await import("@/lib/server/ivora/errors");
    let clock = NOW;
    const ledger = memoryLedger(() => clock);
    for (const s of sessions) await ledger.record(toLedger(s, 5)!);
    // 301 is the oldest check: first in line.
    ledger.rows.get(301)!.checkedAt = NOW - 30 * 60_000;
    ledger.rows.get(302)!.checkedAt = NOW - 20 * 60_000;
    ledger.rows.get(303)!.checkedAt = NOW - 10 * 60_000;
    ivora.getTransaction.mockImplementation(async (id: number) => {
      if (id === 301) throw new IvoraError(500, "internal_error", "boom");
      // 302 comes back without its token.
      if (id === 302) return { ...sessions[1], id_token: null };
      return sessions[2];
    });
    const run = () =>
      refreshCardSessions(
        { ivora, ledger, now: () => clock },
        { deadline: clock + 5_000, maxStations: 0, maxRechecks: 1 },
      );
    await run();
    expect(ivora.getTransaction).toHaveBeenLastCalledWith(
      301,
      expect.anything(),
    );
    // Put off by 2 minutes: the next run, a little later, reads 302.
    expect(ledger.rows.get(301)).toMatchObject({ failures: 1, active: true });
    clock += 60_000;
    await run();
    expect(ivora.getTransaction).toHaveBeenLastCalledWith(
      302,
      expect.anything(),
    );
    expect(ledger.rows.get(302)).toMatchObject({ failures: 1 });
    clock += 60_000;
    await run();
    expect(ivora.getTransaction).toHaveBeenLastCalledWith(
      303,
      expect.anything(),
    );
    // Each failure doubles the wait: after a second one 301 waits 4 minutes.
    clock += 4 * 60_000;
    await run();
    expect(ivora.getTransaction).toHaveBeenLastCalledWith(
      301,
      expect.anything(),
    );
    expect(ledger.rows.get(301)!.failures).toBe(2);
    expect(ledger.rows.get(301)!.checkedAt).toBe(clock + 4 * 60_000);
  });

  it("takes a session Live's tracker already read instead of reading it again", async () => {
    const ended = tx(401, { id_token: "****beef", energy_wh: 7_000 });
    const { ivora } = fakeIvora([ended, tx(402)]);
    const tracked: TrackedSession = {
      transactionId: 401,
      stationId: 5,
      connectorId: 51,
      connectorNumber: 1,
      idToken: "****beef",
      startedAt: ended.started_at,
      endedAt: ended.ended_at,
      energyWh: 7_000,
      active: false,
      checkedAt: new Date(NOW - DAY).toISOString(),
      changedAt: new Date(NOW - DAY).toISOString(),
    };
    const tracker = {
      getTrackedSession: vi.fn(async (id: number) =>
        id === 401 ? tracked : null,
      ),
    };
    const ledger = memoryLedger();
    const r = await refreshCardSessions(
      { ivora, ledger, tracker, now: () => NOW },
      { deadline: NOW + 5_000, maxStations: 1 },
    );
    expect(r).toMatchObject({ reused: 1, recorded: 2 });
    expect(ivora.getTransaction).toHaveBeenCalledTimes(1);
    expect(ivora.getTransaction).toHaveBeenCalledWith(402, expect.anything());
    expect(ledger.rows.get(401)).toMatchObject({
      key: "BEEF",
      energyWh: 7_000,
      active: false,
    });
  });

  it("does nothing in demo mode, where the sample history is the ledger", async () => {
    const { ivora } = fakeIvora([tx(101)]);
    const r = await refreshCardSessions(
      { ivora, ledger: createDemoLedger(() => NOW) },
      { deadline: NOW + 5_000 },
    );
    expect(r).toEqual({
      stations: 0,
      reads: 0,
      reused: 0,
      recorded: 0,
      limited: false,
    });
    expect(ivora.listAllStations).not.toHaveBeenCalled();
  });
});
