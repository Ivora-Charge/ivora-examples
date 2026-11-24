import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server actions read the request's cookies (the admin sessions); tests set them here.
vi.mock(
  "next/headers",
  async () => (await import("./support/request")).nextHeaders,
);

import {
  hubPartyAction,
  listPeersAction,
  syncPeerAction,
} from "@/app/admin/peers/actions";
import { paymentAuditAction, refundAction } from "@/app/admin/payments/actions";
import { requestIdSpent } from "@/app/admin/payments/request-id";
import { reconcileAction } from "@/app/admin/reconciliation/actions";
import { listSessionsAction } from "@/app/admin/sessions/actions";
import { driverAccountAction } from "@/app/admin/tokens/actions";
import { ADMIN_COOKIE } from "@/lib/accounts/admin-session";
import type { AuthProvider } from "@/lib/accounts/auth";
import {
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import { MemoryAccountStore } from "@/lib/accounts/store";
import { explain, explainMessage, OCPI_NEXT_STEP } from "@/lib/admin/errors";
import {
  csvCell,
  e4ToDecimal,
  minorToDecimal,
  reconcileWithPayments,
  reconciliationCsv,
} from "@/lib/admin/reconciliation";
import {
  DEMO_PEER_ID,
  setLocationStoreForTests,
} from "@/lib/locations/registry";
import { MemoryLocationStore } from "@/lib/locations/store";
import { SyncError } from "@/lib/locations/sync";
import {
  cdrForSession,
  sampleCdrToken,
  sampleLocations,
  sampleSessions,
} from "@/lib/mock-cpo/sample-data";
import {
  OcpiClientError,
  OcpiNotSentError,
  OcpiTransportError,
  OcpiUnauthorizedError,
} from "@/lib/ocpi/errors";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { DatabaseRequestError } from "@/lib/server/supabase-rest";
import { setDatabaseCheckForTests } from "@/lib/setup/database";
import {
  setPaymentStoreForTests,
  setStripeForTests,
} from "@/lib/payments/registry";
import { PaymentError } from "@/lib/payments/settle";
import { MemoryPaymentStore, type Payment } from "@/lib/payments/store";
import { StripeUnknownError, type StripeApi } from "@/lib/payments/stripe";
import { resetAdminLimitForTests } from "@/lib/server/admin";
import { asAdmin, type AdminResult } from "@/lib/server/admin-action";
import { DemoModeError } from "@/lib/server/demo";
import { setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { driverStanding } from "@/lib/tokens/authorize";
import { DEMO_DRIVER_REF, setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { LIVE_ENV } from "./support/network";

import {
  requestCookies,
  resetRequest,
  signInWithSecret,
} from "./support/request";

const SECRET = "s".repeat(32);
const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const OTHER = "0c5c1f0e-77a2-4f7e-8f2c-5d0a3e9b6c22";
const saved = { ...process.env };
let peers: MemoryPeerStore;
let fetchSpy: ReturnType<typeof vi.fn>;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  resetAdminLimitForTests();
  for (const k of Object.keys(LIVE_ENV)) delete process.env[k];
  process.env.DEMO_MODE = "true";
  process.env.ADMIN_SECRET = SECRET;
  // Signed in with the admin secret, as the sign-in page does it.
  signInWithSecret();
  peers = new MemoryPeerStore();
  setPeerStoreForTests(peers);
  fetchSpy = vi.fn(() => {
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  setPeerStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setSessionStoreForTests(undefined);
  setPaymentStoreForTests(undefined);
  setAccountStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setStripeForTests(undefined);
  resetRequest();
  vi.unstubAllGlobals();
  process.env = { ...saved };
  expect(fetchSpy).not.toHaveBeenCalled();
});

const request = { request: "GET cpo.example.com/ocpi/2.2.1/locations" };

describe("an OCPI error code and a next step on every error", () => {
  it("names the CPO's OCPI status code, with what to do", () => {
    expect(
      explain(
        new OcpiClientError("failed with OCPI status 2001", {
          ...request,
          statusCode: 2001,
          httpStatus: 400,
        }),
      ),
    ).toEqual({ code: "OCPI 2001", nextStep: OCPI_NEXT_STEP[2001] });
    // An unlisted code falls back to its class.
    expect(
      explain(new OcpiClientError("x", { ...request, statusCode: 3999 }))
        .nextStep,
    ).toBe(OCPI_NEXT_STEP[3000]);
    expect(
      explain(
        new OcpiUnauthorizedError("refused our token (HTTP 401)", {
          ...request,
          httpStatus: 401,
        }),
      ),
    ).toMatchObject({ code: "HTTP 401", nextStep: /Rotate tokens/ });
    expect(explain(new OcpiTransportError("timed out", request))).toMatchObject(
      { code: "no_ocpi_response" },
    );
    expect(explain(new OcpiNotSentError("refused: x", request))).toMatchObject({
      code: "not_sent",
    });
    expect(explain(new DemoModeError("pull"))).toMatchObject({
      code: "demo_mode",
    });
    expect(explain(new SyncError("Pulling failed", 3001, 200))).toMatchObject({
      code: "OCPI 3001",
    });
  });

  it("tells a refused one-time token from a refused permanent token", () => {
    const refused = new OcpiUnauthorizedError("refused our token (HTTP 401)", {
      ...request,
      httpStatus: 401,
    });
    const oneTime = explain(refused, "one-time");
    const permanent = explain(refused, "permanent");
    // Same code either way; the next step differs.
    expect(oneTime.code).toBe("HTTP 401");
    expect(permanent.code).toBe("HTTP 401");
    expect(oneTime.nextStep).toMatch(/new one-time token/);
    expect(oneTime.nextStep).not.toMatch(/Rotate/);
    expect(permanent.nextStep).toMatch(/Rotate tokens.*register again/);
    expect(permanent.nextStep).not.toMatch(
      /new one-time token \(Token A\) from/,
    );
    // No context: the general next step is unchanged.
    expect(explain(refused).nextStep).toMatch(
      /Rotate tokens \(CPO peers\); if/,
    );
    // Through a message (handshake and stored pull errors) and a pull error too.
    const msg =
      "POST cpo.example.com/ocpi/2.2.1/credentials refused our token (HTTP 403)";
    expect(explainMessage(msg, "one-time")).toEqual({
      code: "HTTP 403",
      nextStep: oneTime.nextStep,
    });
    expect(explainMessage(msg, "permanent").nextStep).toBe(permanent.nextStep);
    expect(
      explain(new SyncError("Pulling failed", undefined, 401), "permanent"),
    ).toMatchObject({
      nextStep: permanent.nextStep,
    });
    // Other errors do not change with the context.
    expect(
      explain(new OcpiTransportError("timed out", request), "one-time"),
    ).toEqual(explain(new OcpiTransportError("timed out", request)));
  });

  it("keeps the token context on a refusal an action returns or throws", async () => {
    const opts = (token?: "one-time" | "permanent") => ({
      shown: () => true,
      fallback: "x",
      what: "test",
      token,
    });
    const message =
      "POST cpo.example.com/ocpi/2.2.1/credentials refused our token (HTTP 401)";
    const returned = async (): Promise<AdminResult> => ({ ok: false, message });
    const thrown = async (): Promise<AdminResult> => {
      throw new OcpiUnauthorizedError(message, { ...request, httpStatus: 401 });
    };
    for (const fn of [returned, thrown]) {
      const oneTime = await asAdmin(form({}), fn, opts("one-time"));
      const permanent = await asAdmin(form({}), fn, opts("permanent"));
      const none = await asAdmin(form({}), fn, opts());
      expect(oneTime).toMatchObject({
        ok: false,
        code: "HTTP 401",
        nextStep: explainMessage(message, "one-time").nextStep,
      });
      expect(oneTime.nextStep).toMatch(/new one-time token/);
      expect(permanent.nextStep).toBe(
        explainMessage(message, "permanent").nextStep,
      );
      expect(none.nextStep).toBe(explainMessage(message).nextStep);
      expect(
        new Set([oneTime, permanent, none].map((r) => r.nextStep)).size,
      ).toBe(3);
    }
  });

  it("reads the code back from a message, for handshake errors and stored pulls", () => {
    expect(
      explainMessage(
        "Registration at the CPO failed: POST cpo.example.com/ocpi/2.2.1/credentials failed with OCPI status 3003 (HTTP 200): no endpoints",
      ),
    ).toEqual({ code: "OCPI 3003", nextStep: OCPI_NEXT_STEP[3003] });
    expect(explainMessage("No such peer.")).toMatchObject({
      code: "not_found",
    });
    expect(explainMessage("Peer ID must be a UUID.")).toMatchObject({
      code: "invalid_input",
    });
  });

  it("explains payment errors without card data", () => {
    expect(explain(new PaymentError("x", 502))).toMatchObject({
      code: "stripe_no_answer",
    });
    expect(
      explain(new PaymentError("That is more than what is left to refund.")),
    ).toMatchObject({ code: "above_captured" });
    expect(
      explain(new PaymentError("Stripe refused the refund (charge_disputed).")),
    ).toMatchObject({ code: "stripe_charge_disputed" });
  });

  it("puts one on every refusal of the admin gate and every failed action", async () => {
    resetRequest();
    const signedOut = await listSessionsAction({}, form({}));
    signInWithSecret();
    for (const result of [
      signedOut,
      await listSessionsAction({}, form({ peerId: "not-a-uuid" })),
      await syncPeerAction({}, form({ peerId: PEER })),
      await reconcileAction({}, form({ from: "2026-13-01", to: "2026-10-01" })),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.code).toMatch(/\S/);
      expect(result.nextStep).toMatch(/\S/);
    }
    // The session was made from the secret: without the secret it opens nothing.
    delete process.env.ADMIN_SECRET;
    expect(await listSessionsAction({}, form({}))).toMatchObject({
      ok: false,
      code: "admin_disabled",
    });
  });
});

describe("CPO peers: status, last pull and errors per module", () => {
  it("shows each module's last pull, and a failed one with its OCPI code and next step", async () => {
    const locations = new MemoryLocationStore();
    setLocationStoreForTests(locations);
    const peer = await peers.createPeer({
      label: "CPO A",
      direction: "outbound",
    });
    await locations.saveSyncState(
      {
        peerId: peer.id,
        module: "locations",
        lastFullSyncAt: "2026-10-21T10:00:00.000Z",
        cursor: "2026-10-21T10:00:00.000Z",
        run: null,
        lastResult: {
          ok: true,
          mode: "full",
          finishedAt: "2026-10-21T10:00:05.000Z",
          items: 12,
          invalid: 1,
          removed: 0,
        },
      },
      null,
    );
    await locations.saveSyncState(
      {
        peerId: peer.id,
        module: "cdrs",
        lastFullSyncAt: null,
        cursor: null,
        run: null,
        lastResult: {
          ok: false,
          mode: "full",
          finishedAt: "2026-10-21T11:00:00.000Z",
          items: 0,
          invalid: 0,
          removed: 0,
          error:
            "GET cpo.example.com/ocpi/2.2.1/cdrs failed with OCPI status 2001 (HTTP 400)",
          statusCode: 2001,
          httpStatus: 400,
        },
      },
      null,
    );
    // A result stored before the code was kept: read from its message.
    await locations.saveSyncState(
      {
        peerId: peer.id,
        module: "sessions",
        lastFullSyncAt: null,
        cursor: null,
        run: null,
        lastResult: {
          ok: false,
          mode: "full",
          finishedAt: "2026-10-21T11:00:00.000Z",
          items: 0,
          invalid: 0,
          removed: 0,
          error:
            "GET cpo.example.com/ocpi/2.2.1/sessions failed with HTTP 503 and OCPI status 3000",
        },
      },
      null,
    );
    const listed = await listPeersAction({}, form({}));
    expect(listed.message).toMatch(/1 with a failed pull/);
    const mine = listed.peers!.find((p) => p.id === peer.id)!;
    const by = Object.fromEntries(mine.sync!.map((m) => [m.module, m]));
    expect(by.locations).toMatchObject({
      ok: true,
      items: 12,
      invalid: 1,
      lastPullAt: "2026-10-21T10:00:05.000Z",
      lastFullSyncAt: "2026-10-21T10:00:00.000Z",
    });
    expect(by.locations.code).toBeUndefined();
    expect(by.tariffs).toMatchObject({ ok: null, lastPullAt: null });
    expect(by.cdrs).toMatchObject({
      ok: false,
      code: "OCPI 2001",
      nextStep: OCPI_NEXT_STEP[2001],
    });
    expect(by.sessions).toMatchObject({ ok: false, code: "OCPI 3000" });
    // A registered peer's refused token is the permanent one.
    await locations.saveSyncState(
      {
        peerId: peer.id,
        module: "tariffs",
        lastFullSyncAt: null,
        cursor: null,
        run: null,
        lastResult: {
          ok: false,
          mode: "full",
          finishedAt: "2026-10-21T12:00:00.000Z",
          items: 0,
          invalid: 0,
          removed: 0,
          error:
            "GET cpo.example.com/ocpi/2.2.1/tariffs refused our token (HTTP 401)",
          httpStatus: 401,
          failures: 4,
          requestId: "5b2e0b3c-2d6e-4f65-a8ef-6a8f1c0f9d11",
        },
      },
      null,
    );
    const again = (await listPeersAction({}, form({}))).peers!.find(
      (p) => p.id === peer.id,
    )!;
    expect(again.sync!.find((m) => m.module === "tariffs")).toMatchObject({
      failures: 4,
      requestId: "5b2e0b3c-2d6e-4f65-a8ef-6a8f1c0f9d11",
      nextStep: /Rotate tokens.*register again/,
    });
    // No count was kept for these older results: a failure is at least the first.
    expect(by.cdrs).toMatchObject({ failures: 1 });
    expect(by.cdrs.requestId).toBeUndefined();
    // Demo mode lists the built-in mock CPO first.
    expect(listed.peers![0]).toMatchObject({ id: DEMO_PEER_ID, demo: true });
  });
});

describe("sessions: live and recent, by peer, status and driver", () => {
  function store() {
    const s = new MemorySessionStore();
    const cpo = { countryCode: "ZZ", partyId: "MCK" };
    const emsp = { countryCode: "NL", partyId: "DMO" };
    sampleSessions(cpo, emsp).forEach((session, i) =>
      s.insertSession(
        i === 0 ? OTHER : PEER,
        {
          session,
          fieldTimes: {},
          driverRef: i === 1 ? "driver-1" : null,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      ),
    );
    setSessionStoreForTests(s);
    return s;
  }

  it("counts per status and in total, and says how many of the list are shown", async () => {
    store();
    const live = await listSessionsAction({}, form({}));
    expect(live.counts).toEqual({
      total: 3,
      byStatus: {
        ACTIVE: 1,
        PENDING: 0,
        RESERVATION: 0,
        COMPLETED: 2,
        INVALID: 0,
      },
      more: [],
    });
    expect(live.listTotal).toBe(1);
    expect(live.listTotalMore).toBeUndefined();
    expect(live.message).toBe("1 of 1 session(s).");
    // The chips keep their numbers when one is chosen; the list's total follows it.
    const done = await listSessionsAction({}, form({ status: "COMPLETED" }));
    expect(done.counts).toEqual(live.counts);
    expect(done.listTotal).toBe(2);
    // The peer filter narrows the counts too.
    const other = await listSessionsAction(
      {},
      form({ status: "all", peerId: OTHER }),
    );
    expect(other.counts!.total).toBe(1);
    expect(other.listTotal).toBe(1);
  });

  it("counts a search up to 500 per status, then says 500+", async () => {
    const s = store();
    const [template] = [...s.sessions.values()];
    for (let i = 0; i < 501; i++)
      await s.insertSession(
        PEER,
        {
          session: {
            ...template.session,
            id: `BULK-${i}`,
            status: "COMPLETED",
          },
          fieldTimes: {},
          driverRef: null,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      );
    const all = await listSessionsAction({}, form({ status: "all" }));
    // No search: exact, uncapped counts.
    expect(all.counts!.byStatus.COMPLETED).toBe(503);
    expect(all.counts!.more).toEqual([]);
    const hit = await listSessionsAction(
      {},
      form({ status: "COMPLETED", search: "bulk" }),
    );
    expect(hit.counts).toMatchObject({
      total: 500,
      byStatus: { COMPLETED: 500, ACTIVE: 0 },
      more: ["COMPLETED"],
    });
    expect(hit).toMatchObject({ listTotal: 500, listTotalMore: true });
    // The list keeps its limit of 100.
    expect(hit.sessions).toHaveLength(100);
    expect(hit.message).toMatch(/^100 of 500\+ session\(s\)/);
    // A chip whose statuses were not capped says so exactly.
    const live = await listSessionsAction({}, form({ search: "bulk" }));
    expect(live).toMatchObject({ listTotal: 0 });
    expect(live.listTotalMore).toBeUndefined();
  });

  it("searches by driver, charger or session reference on the server", async () => {
    store();
    const ids = async (search: string, extra = {}) =>
      (
        await listSessionsAction({}, form({ status: "all", search, ...extra }))
      ).sessions?.map((r) => r.ref.split("/")[2]);
    // Driver (part of it, any case), session ID, charger and location.
    expect(await ids("DRIVER-1")).toEqual(["S2"]);
    expect(await ids("s3")).toEqual(["S3"]);
    expect(await ids("LOC1-1")).toEqual(["S1"]);
    expect(await ids("loc2")).toEqual(["S2"]);
    expect(await ids("nothing like it")).toEqual([]);
    // It narrows the counts and the list's total, and combines with the other filters.
    const hit = await listSessionsAction(
      {},
      form({ status: "all", search: "LOC" }),
    );
    expect(hit.counts!.total).toBe(3);
    const narrowed = await listSessionsAction(
      {},
      form({ status: "all", search: "S2", peerId: OTHER }),
    );
    expect(narrowed.sessions).toEqual([]);
    expect(narrowed.filters).toMatchObject({ search: "S2" });
    // A term with pattern characters is refused, not passed to the database.
    for (const bad of ["a%b", 'a"b', "a,b", "x".repeat(65), "a(b"])
      expect(
        await listSessionsAction({}, form({ status: "all", search: bad })),
      ).toMatchObject({ ok: false, message: /Search takes up to 64/ });
  });

  it("shows a session's cost in its own currency, CAD with CA$ and JPY without decimals", async () => {
    const s = new MemorySessionStore();
    const cpo = { countryCode: "ZZ", partyId: "MCK" };
    const emsp = { countryCode: "NL", partyId: "DMO" };
    const [base] = sampleSessions(cpo, emsp);
    for (const [id, currency, total] of [
      ["cad", "CAD", { excl_vat: 19.18, incl_vat: 23.21 }],
      ["jpy", "JPY", { excl_vat: 1350 }],
    ] as const)
      s.insertSession(
        PEER,
        {
          session: {
            ...base,
            id,
            currency,
            total_cost: total,
            status: "COMPLETED",
          },
          fieldTimes: {},
          driverRef: null,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      );
    setSessionStoreForTests(s);
    const all = await listSessionsAction({}, form({ status: "all" }));
    const cost = (ref: string) =>
      all.sessions!.find((r) => r.ref.endsWith(`/${ref}`))!.cost;
    expect(cost("cad")).toBe("CA$19.18 excl. VAT, CA$23.21 incl.");
    expect(cost("jpy")).toBe("¥1,350 excl. VAT");
  });

  it("lists live sessions by default, and filters by status, peer and driver", async () => {
    store();
    const live = await listSessionsAction({}, form({}));
    expect(live.sessions!.map((s) => s.status)).toEqual(["ACTIVE"]);
    const all = await listSessionsAction({}, form({ status: "all" }));
    expect(all.sessions).toHaveLength(3);
    // Newest start first.
    const starts = all.sessions!.map((s) => Date.parse(s.start));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    expect(
      (await listSessionsAction({}, form({ status: "COMPLETED" }))).sessions,
    ).toHaveLength(2);
    expect(
      (await listSessionsAction({}, form({ status: "all", peerId: OTHER })))
        .sessions,
    ).toHaveLength(1);
    const driver = await listSessionsAction(
      {},
      form({ status: "all", driverRef: "driver-1" }),
    );
    expect(driver.sessions!.map((s) => s.driverRef)).toEqual(["driver-1"]);
    expect(
      (
        await listSessionsAction(
          {},
          form({ status: "all", before: "2026-09-01" }),
        )
      ).message,
    ).toBe("No sessions match.");
  });

  it("pages by start timestamp, never skipping sessions that started together", async () => {
    const s = new MemorySessionStore();
    const [template] = sampleSessions(
      { countryCode: "ZZ", partyId: "MCK" },
      { countryCode: "NL", partyId: "DMO" },
    );
    // 103 sessions, one a minute; the 100th and 101st newest start at the same time.
    const T = Date.parse("2026-10-01T00:00:00Z");
    for (let i = 0; i < 103; i++) {
      const minutes = i === 100 ? 99 : i;
      await s.insertSession(
        PEER,
        {
          session: {
            ...template,
            id: `S-${i}`,
            status: "COMPLETED",
            start_date_time: new Date(T - minutes * 60_000).toISOString(),
          },
          fieldTimes: {},
          driverRef: null,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      );
    }
    setSessionStoreForTests(s);

    const first = await listSessionsAction({}, form({ status: "all" }));
    expect(first.sessions).toHaveLength(100);
    expect(first.message).toContain("Show older sessions");
    expect(first.filters).toEqual({
      status: "all",
      peerId: "",
      driverRef: "",
      search: "",
      before: "",
    });
    expect(first.nextBefore).toBe("2026-09-30T22:21:00.001Z");

    const next = await listSessionsAction(
      {},
      form({ status: "all", older: first.nextBefore! }),
    );
    const seen = new Set(first.sessions!.map((r) => r.ref));
    const refs = next.sessions!.map((r) => r.ref);
    // The one that started with the oldest listed is on the next page, as is the rest.
    expect(new Set([...seen, ...refs]).size).toBe(103);
    expect(refs).toHaveLength(4);
    expect(next.nextBefore).toBeUndefined();
    expect(next.filters!.before).toBe(first.nextBefore);

    // A UTC timestamp or day is taken as "Started before"; anything else is refused.
    expect(
      (
        await listSessionsAction(
          {},
          form({ status: "all", before: "2026-09-30T23:00:00Z" }),
        )
      ).sessions,
    ).toHaveLength(42);
    expect(
      await listSessionsAction(
        {},
        form({ status: "all", before: "2026-09-30 10:00" }),
      ),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses an unknown status or a malformed peer ID", async () => {
    store();
    expect(
      await listSessionsAction({}, form({ status: "DROP TABLE" })),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await listSessionsAction({}, form({ peerId: "../x" })),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

/** Sessions, CDRs and payments: one paid in full, one under-captured, one unpaid. */
async function ledger() {
  const sessions = new MemorySessionStore();
  const payments = new MemoryPaymentStore(() => sessions.cdrs.values());
  const cpo = { countryCode: "ZZ", partyId: "MCK" };
  const emsp = { countryCode: "NL", partyId: "DMO" };
  const now = "2026-10-01T06:00:00.000Z";
  const [s1, s2] = sampleSessions(cpo, emsp);
  const locations = sampleLocations(cpo, 3);
  const made: Payment[] = [];
  for (const [i, session] of [s1, s2].entries()) {
    const commandId = crypto.randomUUID();
    await sessions.insertSession(
      PEER,
      {
        session,
        fieldTimes: {},
        driverRef: "driver-1",
        commandId,
        completedAt: now,
      },
      now,
    );
    const cdr = await sessions.insertCdr(
      PEER,
      {
        cdr: cdrForSession(
          session,
          locations.find((l) => l.id === session.location_id)!,
          { id: `CDR-${i}`, cdr_token: sampleCdrToken(emsp) },
        ),
        driverRef: "driver-1",
        commandId,
        source: "push",
      },
      now,
    );
    if (i === 1) continue; // the second CDR has no payment
    const p = (await payments.insert(
      {
        commandId,
        driverRef: "driver-1",
        currency: "EUR",
        holdAmount: 2500,
        paymentMethodId: null,
      },
      now,
    ))!;
    made.push(
      (await payments.transition(
        p.id,
        ["pending"],
        {
          status: "captured",
          authorizedAmount: 2500,
          capturedAmount: 2000,
          cdrId: cdr!.id,
          cdrCurrency: "EUR",
          cdrAmount: 2321,
          review: "cdr_above_hold",
          shortfallAmount: 321,
        },
        now,
      ))!,
    );
  }
  return { sessions, payments, made };
}

describe("CDR reconciliation per peer", () => {
  it("compares sessions, CDRs and captured amounts, and lists the mismatches", async () => {
    const { sessions, payments, made } = await ledger();
    const report = await reconcileWithPayments(
      { from: "2026-09-29", to: "2026-10-02", peerId: PEER },
      { sessions, payments },
    );
    expect(report.totals).toHaveLength(1);
    const t = report.totals[0];
    expect(t).toMatchObject({
      peerId: PEER,
      currency: "EUR",
      sessions: 2,
      cdrs: 2,
      cdrsPaid: 1,
      cdrsUnpaid: 1,
      capturedAmount: 2000,
      cdrAmount: 2321,
      amountMismatches: 1,
    });
    expect(t.mismatches).toBe(2);
    const day = report.days.find((d) => d.cdrsUnpaid)!;
    expect(day.cdrsUnpaidIds).toEqual(["ZZ/MCK/CDR-1"]);
    expect(report.days.flatMap((d) => d.amountMismatchIds)).toEqual([
      made[0].id,
    ]);

    // Another peer's range has none of it.
    expect(
      (
        await reconcileWithPayments(
          { from: "2026-09-29", to: "2026-10-02", peerId: OTHER },
          { sessions, payments },
        )
      ).days,
    ).toEqual([]);

    const csv = reconciliationCsv(report, new Map([[PEER, "=CPO A"]]));
    const [head, ...rows] = csv.trimEnd().split("\r\n");
    expect(head.split(",")).toContain("amount_mismatch_payment_ids");
    expect(rows.join("\n")).toContain(made[0].id);
    // A label a spreadsheet would run as a formula is escaped.
    expect(rows[0]).toContain(",'=CPO A,");
    expect(rows.join("\n")).toContain(",20.00,"); // captured, in EUR
  });

  it("formats E4 and minor units exactly, and escapes CSV cells", () => {
    expect(e4ToDecimal(125000)).toBe("12.5");
    expect(e4ToDecimal(-5)).toBe("-0.0005");
    expect(e4ToDecimal(0)).toBe("0");
    expect(minorToDecimal(1235, "EUR")).toBe("12.35");
    expect(minorToDecimal(-5, "EUR")).toBe("-0.05");
    expect(minorToDecimal(1235, "JPY")).toBe("1235");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(null)).toBe("");
  });

  it("runs from the admin web in demo mode, with a CSV and the flagged payments", async () => {
    const { sessions, payments } = await ledger();
    setSessionStoreForTests(sessions);
    setPaymentStoreForTests(payments);
    const r = await reconcileAction(
      {},
      form({ from: "2026-09-29", to: "2026-10-02" }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/2 mismatch\(es\).*1 payment\(s\) flagged/);
    expect(r.flagged).toEqual([
      expect.objectContaining({
        review: "cdr_above_hold",
        captured: "20.00 EUR",
        shortfall: "3.21 EUR",
      }),
    ]);
    expect(r.totals![0].problems.map((p) => p.what)).toEqual([
      "CDRs of our drivers with no payment",
      "Payments whose capture is not the CDR total",
    ]);
    expect(r.csv).toMatch(/^peer_id,peer,day,currency,/);
    expect(r.filename).toBe("reconciliation_all_2026-09-29_2026-10-02.csv");
    expect(
      await reconcileAction({}, form({ from: "2026-01-01", to: "2026-10-01" })),
    ).toMatchObject({ ok: false, message: /At most 92 days/ });
  });
});

describe("refunds: partial or full, with a reason and an audit log", () => {
  async function captured() {
    const payments = new MemoryPaymentStore();
    setPaymentStoreForTests(payments);
    const p = (await payments.insert(
      {
        commandId: crypto.randomUUID(),
        driverRef: "driver-1",
        currency: "EUR",
        holdAmount: 2500,
        paymentMethodId: null,
      },
      "2026-10-01T06:00:00.000Z",
    ))!;
    await payments.transition(
      p.id,
      ["pending"],
      { status: "captured", authorizedAmount: 2500, capturedAmount: 1500 },
      "2026-10-01T07:00:00.000Z",
    );
    return { payments, p };
  }

  it("needs a reason", async () => {
    const { p } = await captured();
    expect(
      await refundAction(
        {},
        form({ paymentId: p.id, amount: "100", requestId: "refund-r-1" }),
      ),
    ).toMatchObject({
      ok: false,
      message: "Give a reason for the refund.",
      code: "invalid_input",
    });
  });

  it("refunds part, then everything left, never more, and audits who and why", async () => {
    const { payments, p } = await captured();
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          amount: "500",
          requestId: "refund-r-1",
          reason: "Charger fault",
        }),
      ),
    ).toMatchObject({ ok: true, message: "Refunded €5.00 (500 minor units)." });
    const full = await refundAction(
      {},
      form({
        paymentId: p.id,
        full: "on",
        requestId: "refund-r-2",
        reason: "Goodwill",
      }),
    );
    expect(full).toMatchObject({
      ok: true,
      message: "Refunded €10.00 (1000 minor units).",
    });
    expect((await payments.get(p.id))!.refundedAmount).toBe(1500);
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          full: "on",
          requestId: "refund-r-3",
          reason: "Again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "above_captured" });
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          amount: "1",
          requestId: "refund-r-4",
          reason: "Again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "above_captured" });

    const refunds = await payments.listRefunds(p.id);
    expect(refunds.map((r) => [r.amount, r.reason, r.actor])).toEqual([
      [500, "Charger fault", "admin:secret"],
      [1000, "Goodwill", "admin:secret"],
    ]);
    const audit = await paymentAuditAction(
      {},
      form({ paymentId: p.commandId }),
    );
    expect(audit.payments![0].id).toBe(p.id);
    expect(audit.audit!.map((a) => [a.actor, a.action])).toEqual([
      ["admin:secret", "payment.refund_succeeded"],
      ["admin:secret", "payment.refund_succeeded"],
    ]);
    expect(audit.audit![0].details).toContain("reason: Goodwill");
    expect(audit.audit![1].details).toContain("amount: 500");
  });

  it("retries a full refund Stripe never answered with its own amount and key", async () => {
    Object.assign(process.env, LIVE_ENV);
    delete process.env.DEMO_MODE;
    const { payments, p } = await captured();
    await payments.transition(
      p.id,
      ["captured"],
      { paymentIntentId: "pi_test_1" },
      "2026-10-01T07:00:00.000Z",
    );
    const keys: string[] = [];
    const refund = vi.fn(async (input: { amount: number }, key: string) => {
      keys.push(key);
      if (keys.length === 1) throw new StripeUnknownError("refund: no answer");
      return { id: "re_test_1", status: "succeeded", amount: input.amount };
    });
    setStripeForTests({ refund } as unknown as StripeApi);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const full = form({
      paymentId: p.id,
      full: "on",
      requestId: "refund-full-1",
      reason: "Charger fault",
    });

    const first = await refundAction({}, full);
    expect(first).toMatchObject({ ok: false, code: "stripe_no_answer" });
    expect(requestIdSpent(first)).toBe(false);
    // 1,500 is reserved by the pending refund, with no Stripe ID yet.
    expect(await payments.listRefunds(p.id)).toEqual([
      expect.objectContaining({
        amount: 1500,
        status: "pending",
        stripeRefundId: null,
      }),
    ]);

    // The same form again: the same 1,500 and the same key, not "nothing left".
    const again = await refundAction({}, full);
    expect(again).toMatchObject({
      ok: true,
      message: "Refunded €15.00 (1500 minor units).",
    });
    expect(requestIdSpent(again)).toBe(true);
    expect(refund.mock.calls.map(([input]) => input.amount)).toEqual([
      1500, 1500,
    ]);
    expect(keys[1]).toBe(keys[0]);
    expect(await payments.listRefunds(p.id)).toEqual([
      expect.objectContaining({ amount: 1500, status: "succeeded" }),
    ]);
    expect((await payments.get(p.id))!.refundedAmount).toBe(1500);

    // A third send replays the settled refund: Stripe is not called again.
    expect(await refundAction({}, full)).toMatchObject({ ok: true });
    expect(refund).toHaveBeenCalledTimes(2);
    // A new request ID finds nothing left.
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          full: "on",
          requestId: "refund-full-2",
          reason: "Again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "above_captured" });
  });

  it("spends the form's request ID once the outcome is known, keeps it otherwise", () => {
    const shown = { payments: [] };
    for (const r of [
      { ok: true, ...shown },
      { ok: false, code: "refund_failed", ...shown },
      { ok: false, code: "refund_pending", ...shown },
      { ok: false, code: "refund_requires_action", ...shown },
      { ok: false, code: "stripe_card_declined" },
      { ok: false, code: "request_reused" },
    ])
      expect(requestIdSpent(r)).toBe(true);
    for (const r of [
      { ok: false, code: "stripe_no_answer" },
      { ok: false, code: "unexpected" },
      { ok: false, code: "invalid_input" },
      { ok: false, code: "above_captured" },
      { ok: false, code: "signed_out" },
      { ok: false, code: "session_expired" },
      { ok: false, code: "session_limited" },
    ])
      expect(requestIdSpent(r)).toBe(false);
  });
});

describe("the admin gate on reconciliation, audit, driver and refund actions", () => {
  const actions = {
    reconcileAction,
    paymentAuditAction,
    driverAccountAction,
    refundAction,
  };
  const raw = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  /** Signs a user in with `role` (an auth provider that knows one token). */
  function signIn(role: "admin" | "viewer") {
    const user = { id: crypto.randomUUID(), email: `${role}@example.com` };
    const token = `token-${user.id}`;
    setAuthProviderForTests({
      getUser: async (t: string) => (t === token ? user : null),
    } as unknown as AuthProvider);
    const accounts = new MemoryAccountStore();
    accounts.admins.set(user.id, role);
    setAccountStoreForTests(accounts);
    requestCookies.set(ADMIN_COOKIE, token);
    return { user, accounts };
  }
  const GATE = [
    "signed_out",
    "session_expired",
    "read_only",
    "admin_disabled",
    "rate_limited",
  ];

  for (const [name, action] of Object.entries(actions)) {
    it(`${name}: refuses no session, a session of another secret and a viewer, lets an admin in`, async () => {
      setPaymentStoreForTests(new MemoryPaymentStore());
      resetRequest();
      expect(await action({}, raw({}))).toMatchObject({
        ok: false,
        code: "signed_out",
      });
      // The secret in a form field opens nothing: no action reads it.
      expect(await action({}, raw({ adminSecret: SECRET }))).toMatchObject({
        ok: false,
        code: "signed_out",
      });
      // A session signed with another secret.
      process.env.ADMIN_SECRET = "x".repeat(32);
      signInWithSecret();
      process.env.ADMIN_SECRET = SECRET;
      expect(await action({}, raw({}))).toMatchObject({
        ok: false,
        code: "signed_out",
      });

      // Without ADMIN_SECRET, nobody gets in without signing in.
      signInWithSecret();
      delete process.env.ADMIN_SECRET;
      expect(await action({}, raw({}))).toMatchObject({
        ok: false,
        code: "admin_disabled",
      });

      signIn("viewer");
      expect(await action({}, raw({}))).toMatchObject({
        ok: false,
        code: "read_only",
      });

      signIn("admin");
      const r = await action({}, raw({}));
      expect(GATE).not.toContain(r.code);
    });
  }

  it("hubPartyAction push_mode: refuses the secret in a form and a viewer, lets an admin in", async () => {
    // A registered hub, kept on per-party pushes; demo mode is off for this one.
    process.env.DEMO_MODE = "false";
    Object.assign(process.env, LIVE_ENV);
    const hub = await peers.createPeer({ label: "Hub", direction: "outbound" });
    await peers.updatePeer(hub.id, {
      status: "registered",
      hubPushMode: "per_party",
      roles: [
        {
          role: "HUB",
          country_code: "ZZ",
          party_id: "HUB",
          business_details: { name: "Hub" },
        },
      ],
    });
    setTokenStoreForTests(new MemoryTokenStore());
    try {
      const pushMode = (fields: Record<string, string> = {}) =>
        hubPartyAction(
          {},
          raw({ peerId: hub.id, intent: "push_mode", mode: "hub", ...fields }),
        );
      resetRequest();
      expect(await pushMode({ adminSecret: SECRET })).toMatchObject({
        ok: false,
        code: "signed_out",
      });
      delete process.env.ADMIN_SECRET;
      signIn("viewer");
      expect(await pushMode()).toMatchObject({ ok: false, code: "read_only" });
      expect((await peers.getPeer(hub.id))!.hubPushMode).toBe("per_party");

      signIn("admin");
      expect(await pushMode()).toMatchObject({
        ok: true,
        peer: { hub: { pushMode: "hub" } },
      });
      expect((await peers.getPeer(hub.id))!.hubPushMode).toBe("hub");
    } finally {
      setTokenStoreForTests(undefined);
    }
  });

  it("hubPartyAction push_mode: a pending migration is named, with the code the selector links from", async () => {
    process.env.DEMO_MODE = "false";
    Object.assign(process.env, LIVE_ENV);
    const hub = await peers.createPeer({ label: "Hub", direction: "outbound" });
    await peers.updatePeer(hub.id, {
      status: "registered",
      hubPushMode: "per_party",
      roles: [
        {
          role: "HUB",
          country_code: "ZZ",
          party_id: "HUB",
          business_details: { name: "Hub" },
        },
      ],
    });
    // The switch function of the push-mode migration is missing: the save is refused as
    // "no such function".
    peers.setHubPushMode = async () => {
      throw new DatabaseRequestError("no such function", 404, "PGRST202");
    };
    setDatabaseCheckForTests(async () => ({
      state: "pending",
      shipped: 2,
      applied: 1,
      pending: ["202611240001_hub_push_mode.sql"],
      newest: "202611240001_hub_push_mode.sql",
    }));
    setTokenStoreForTests(new MemoryTokenStore());
    try {
      delete process.env.ADMIN_SECRET;
      signIn("admin");
      const r = await hubPartyAction(
        {},
        raw({ peerId: hub.id, intent: "push_mode", mode: "hub" }),
      );
      expect(r).toMatchObject({ ok: false, code: "migration_pending" });
      expect(r.message).toContain("202611240001_hub_push_mode.sql");
      expect(r.nextStep).toContain("Setup");
      expect((await peers.getPeer(hub.id))!.hubPushMode).toBe("per_party");
    } finally {
      setDatabaseCheckForTests(undefined);
      setTokenStoreForTests(undefined);
    }
  });

  it("records the signed-in admin, not the secret, on a refund", async () => {
    delete process.env.ADMIN_SECRET;
    const { user } = signIn("admin");
    const payments = new MemoryPaymentStore();
    setPaymentStoreForTests(payments);
    const p = (await payments.insert(
      {
        commandId: crypto.randomUUID(),
        driverRef: "driver-1",
        currency: "EUR",
        holdAmount: 2500,
        paymentMethodId: null,
      },
      "2026-10-01T06:00:00.000Z",
    ))!;
    await payments.transition(
      p.id,
      ["pending"],
      { status: "captured", authorizedAmount: 2500, capturedAmount: 1500 },
      "2026-10-01T07:00:00.000Z",
    );
    expect(
      await refundAction(
        {},
        raw({
          paymentId: p.id,
          amount: "200",
          requestId: "refund-admin-1",
          reason: "Charger fault",
        }),
      ),
    ).toMatchObject({ ok: true });
    expect((await payments.listRefunds(p.id))[0].actor).toBe(
      `admin:${user.id}`,
    );
  });
});

describe("drivers: block and unblock", () => {
  it("blocks a driver from charging, audits it, and unblocks", async () => {
    const accounts = new MemoryAccountStore();
    await accounts.ensureDriver(
      DEMO_DRIVER_REF,
      "driver@example.com",
      "2026-10-01T00:00:00.000Z",
    );
    setAccountStoreForTests(accounts);
    const token = {
      type: "APP_USER",
      driverRef: DEMO_DRIVER_REF,
      id: "t1",
    } as Parameters<typeof driverStanding>[0];

    const blocked = await driverAccountAction(
      {},
      form({ driverRef: DEMO_DRIVER_REF, intent: "block" }),
    );
    expect(blocked).toMatchObject({
      ok: true,
      driver: { id: DEMO_DRIVER_REF, status: "restricted" },
    });
    expect(await driverStanding(token, accounts)).toBe("not_allowed");
    expect(
      await driverAccountAction(
        {},
        form({ driverRef: DEMO_DRIVER_REF, intent: "unblock" }),
      ),
    ).toMatchObject({ ok: true, driver: { status: "active" } });
    expect(
      (await peers.listAudit(DEMO_DRIVER_REF, 10)).map((a) => a.action),
    ).toEqual(["driver.unblock", "driver.block"]);
    // Never the card or the Stripe customer.
    expect(JSON.stringify(blocked)).not.toMatch(/pm_|cus_/);
  });

  it("explains a driver with no account", async () => {
    setAccountStoreForTests(new MemoryAccountStore());
    expect(
      await driverAccountAction(
        {},
        form({ driverRef: "nobody", intent: "block" }),
      ),
    ).toMatchObject({ ok: false, code: "not_found", nextStep: /tokens/ });
  });
});
