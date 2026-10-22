import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/roles";
import { AccessDeniedError } from "@/lib/server/auth";
import { getIvora, resetIvoraForTests } from "@/lib/server/ivora";
import { createDemoClient } from "@/lib/server/ivora/demo";
import { memoryDemoFleet } from "@/lib/server/ivora/demo";
import { DEMO_TAKEN_PARTY, memoryDemoOcpi } from "@/lib/server/ivora/demo-ocpi";
import { createLiveClient } from "@/lib/server/ivora/live";
import type { OcpiSettings } from "@/lib/server/ivora/types";
import { getRoaming } from "@/lib/server/roaming";
import { parseRoamingForm, type RoamingForm } from "@/lib/server/roaming/input";
import {
  decideDemoParty,
  loadRoaming,
  roamingKey,
  saveRoaming,
} from "@/lib/server/roaming/service";
import { RoamingError } from "@/lib/server/roaming/types";
import type { Staff } from "@/lib/server/team/types";

// Roaming runs against the live client over a fake fetch (routed by method and path)
// and against the demo client, so the API contract (full PUT, Idempotency-Key, 409s)
// is covered with no network or credentials.

const API_KEY = "test-api-key";

function staff(role: Role, demo = false): Staff {
  return {
    userId: `00000000-0000-4000-8000-00000000000${role.length}`,
    email: `${role}@example.com`,
    role,
    operatorId: "10000000-0000-4000-8000-0000000000aa",
    operatorName: "Sample Operator",
    demo,
  };
}
const owner = staff("owner");
const manager = staff("manager");
const technician = staff("technician");
const viewer = staff("viewer");

const SETTINGS: OcpiSettings = {
  publish: false,
  private: false,
  published: false,
  display_name: null,
  website: null,
  time_zone: null,
  connector_defaults: {
    standard: "IEC_62196_T1",
    format: "CABLE",
    power_type: "AC_1_PHASE",
    max_voltage: 240,
    max_amperage: 40,
  },
  excluded_location_ids: [7, 99],
  own_party: null,
  party: { country_code: "US", party_id: "IVR", shared: true },
  versions_url: "https://ocpi.example.test/versions",
  updated_at: "2026-10-20T10:00:00Z",
};

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Route = (call: Call) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const apiError = (status: number, code: string) =>
  json(status, { error: { code, message: code }, request_id: "req_1" });

function fakeApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const call: Call = {
        method: init?.method ?? "GET",
        path: u.pathname.replace("/v1/tenants/42/", ""),
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
  return { calls, deps: { ivora, demoOcpi: null } };
}

const FORM: RoamingForm = {
  publish: "on",
  displayName: "  Northside EV  ",
  website: "https://northside.example",
  timeZone: "America/Chicago",
  countryCode: "us",
  partyId: "nth",
  revision: SETTINGS.updated_at!,
  shownLocations: ["7", "8", "9"],
  publishedLocations: ["7", "9"],
};

const LIVE_ENV = {
  IVORA_API_KEY: API_KEY,
  IVORA_TENANT_ID: "42",
  SUPABASE_URL: "https://supabase.example.test",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

describe("roaming form", () => {
  it("accepts a full form, trims and upper-cases", () => {
    const r = parseRoamingForm(FORM);
    expect(r).toMatchObject({
      ok: true,
      value: {
        publish: true,
        displayName: "Northside EV",
        ownParty: { country_code: "US", party_id: "NTH" },
        shownLocations: [7, 8, 9],
        publishedLocations: [7, 9],
      },
    });
  });

  it("empty party fields mean the shared party", () => {
    const r = parseRoamingForm({ ...FORM, countryCode: " ", partyId: "" });
    expect(r.ok && r.value.ownParty).toBeNull();
  });

  it("lists every problem, as the API would refuse them", () => {
    const r = parseRoamingForm({
      ...FORM,
      displayName: "",
      website: "http://plain.example",
      timeZone: "UTC",
      countryCode: "USA",
      partyId: "",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join("\n")).toMatch(/Website: a full https/);
    expect(r.problems.join("\n")).toMatch(/Time zone/);
    expect(r.problems.join("\n")).toMatch(/Country code/);
    expect(r.problems.join("\n")).toMatch(/Operator name: needed to publish/);
    expect(r.problems.join("\n")).toMatch(/fill in both/);
  });

  it("refuses Ivora's shared party as an own party", () => {
    const r = parseRoamingForm({ ...FORM, countryCode: "US", partyId: "IVR" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/shared party/);
  });
});

describe("roaming against the live API", () => {
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
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("is for owners and managers only, checked before any request", async () => {
    const api = fakeApi({});
    for (const actor of [technician, viewer]) {
      await expect(loadRoaming(api.deps, actor)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(saveRoaming(api.deps, actor, FORM)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(
        decideDemoParty(api.deps, actor, "approve"),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    expect(api.calls).toHaveLength(0);
  });

  it("loads settings, sites and imported EVSE IDs with charger names", async () => {
    const api = fakeApi({
      "GET ocpi": () => json(200, SETTINGS),
      "GET locations": () =>
        json(200, {
          data: [
            { id: 7, name: "Depot" },
            { id: 8, name: "Main Street" },
          ],
        }),
      "GET ocpi/evse-ids": () =>
        json(200, {
          party: SETTINGS.party,
          data: [
            {
              station_id: 41,
              evse_number: 2,
              evse_id: "US*XYZ*E124",
              applies: false,
            },
            {
              station_id: 41,
              evse_number: 1,
              evse_id: "US*XYZ*E123",
              applies: false,
            },
          ],
        }),
      "GET stations": () =>
        json(200, { data: [{ id: 41, name: "CP-41", online: true }] }),
    });
    const v = await loadRoaming(api.deps, manager);
    expect(v.revision).toBe(SETTINGS.updated_at);
    expect(v.sites).toEqual([
      { id: 7, name: "Depot", published: false },
      { id: 8, name: "Main Street", published: true },
    ]);
    // 99 is excluded but not listed (removed, or past the list): it is kept.
    expect(v.otherExcluded).toEqual([99]);
    expect(v.evseIds.map((e) => [e.evse_id, e.stationName])).toEqual([
      ["US*XYZ*E123", "CP-41"],
      ["US*XYZ*E124", "CP-41"],
    ]);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("still shows the settings when the sites or EVSE IDs can't be read", async () => {
    const api = fakeApi({
      "GET ocpi": () => json(200, SETTINGS),
      "GET locations": () => apiError(403, "forbidden"),
      "GET ocpi/evse-ids": () => apiError(403, "forbidden"),
    });
    const v = await loadRoaming(api.deps, owner);
    expect(v.sitesError).toMatch(/forbidden/);
    expect(v.evseIdsError).toMatch(/forbidden/);
    expect(v.otherExcluded).toEqual([7, 99]);
  });

  it("PUTs the whole object with a derived Idempotency-Key", async () => {
    const answer = {
      ...SETTINGS,
      publish: true,
      published: true,
      own_party: {
        country_code: "US",
        party_id: "NTH",
        status: "pending_approval",
        rejection_note: null,
      },
      updated_at: "2026-10-22T09:00:00Z",
    };
    const api = fakeApi({
      "GET ocpi": () => json(200, SETTINGS),
      "PUT ocpi": () => json(200, answer),
    });
    const r = await saveRoaming(api.deps, manager, FORM);
    expect(r.partyRequested).toBe(true);
    const put = api.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({
      publish: true,
      display_name: "Northside EV",
      website: "https://northside.example",
      time_zone: "America/Chicago",
      // Not edited by the kit: sent back as Ivora answered, so PUT keeps it.
      connector_defaults: SETTINGS.connector_defaults,
      // 99 was not listed, so it stays excluded; 8 was unticked; 7 was ticked again.
      excluded_location_ids: [8, 99],
      own_party: { country_code: "US", party_id: "NTH" },
    });
    const key = put.headers.get("idempotency-key");
    expect(key).toBe(
      roamingKey(
        SETTINGS.updated_at!,
        put.body as Parameters<typeof roamingKey>[1],
      ),
    );
    expect(key).toMatch(/^cpo-ocpi-settings-[0-9a-f]{32}-put$/);
    expect(put.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("the same save from the same starting point reuses its key; a different one does not", () => {
    const body = {
      publish: false,
      display_name: null,
      website: null,
      time_zone: null,
      connector_defaults: null,
      excluded_location_ids: [],
      own_party: null,
    };
    expect(roamingKey("a", body)).toBe(roamingKey("a", body));
    expect(roamingKey("b", body)).not.toBe(roamingKey("a", body));
    expect(roamingKey("a", { ...body, publish: true })).not.toBe(
      roamingKey("a", body),
    );
  });

  it("retries a lost answer with the same key", async () => {
    let tries = 0;
    const api = fakeApi({
      "GET ocpi": () => json(200, SETTINGS),
      "PUT ocpi": () =>
        ++tries === 1
          ? apiError(503, "outcome_unknown")
          : json(200, { ...SETTINGS, updated_at: "2026-10-22T09:00:00Z" }),
    });
    await saveRoaming(api.deps, owner, {
      ...FORM,
      countryCode: "",
      partyId: "",
    });
    const puts = api.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0].headers.get("idempotency-key")).toBe(
      puts[1].headers.get("idempotency-key"),
    );
  });

  it("refuses a save over someone else's newer change", async () => {
    const api = fakeApi({
      "GET ocpi": () =>
        json(200, { ...SETTINGS, updated_at: "2026-10-21T12:00:00Z" }),
    });
    await expect(saveRoaming(api.deps, manager, FORM)).rejects.toMatchObject({
      code: "stale",
    });
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a resubmit of a save that already landed succeeds without a second PUT", async () => {
    const landed: OcpiSettings = {
      ...SETTINGS,
      publish: true,
      display_name: "Northside EV",
      website: "https://northside.example",
      time_zone: "America/Chicago",
      excluded_location_ids: [8, 99],
      own_party: {
        country_code: "US",
        party_id: "NTH",
        status: "pending_approval",
        rejection_note: null,
      },
      updated_at: "2026-10-22T09:00:00Z",
    };
    const api = fakeApi({ "GET ocpi": () => json(200, landed) });
    const r = await saveRoaming(api.deps, manager, FORM);
    expect(r.settings).toEqual(landed);
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("explains 409 ocpi_tenant_private", async () => {
    const api = fakeApi({
      "GET ocpi": () => json(200, SETTINGS),
      "PUT ocpi": () => apiError(409, "ocpi_tenant_private"),
    });
    const e = await saveRoaming(api.deps, manager, FORM).catch((x) => x);
    expect(e).toBeInstanceOf(RoamingError);
    expect(e.code).toBe("tenant_private");
    expect(e.message).toMatch(/keeps this network private/);
  });

  it("explains 409 ocpi_party_in_use with the party", async () => {
    const api = fakeApi({
      "GET ocpi": () => json(200, SETTINGS),
      "PUT ocpi": () => apiError(409, "ocpi_party_in_use"),
    });
    const e = await saveRoaming(api.deps, manager, FORM).catch((x) => x);
    expect(e).toBeInstanceOf(RoamingError);
    expect(e.code).toBe("party_in_use");
    expect(e.message).toMatch(/US\*NTH for another operator/);
  });

  it("refuses a form error before any request", async () => {
    const api = fakeApi({});
    const e = await saveRoaming(api.deps, manager, {
      ...FORM,
      displayName: "",
      website: "ftp://x",
    }).catch((x) => x);
    expect(e).toBeInstanceOf(RoamingError);
    expect(e.problems.length).toBeGreaterThan(0);
    expect(api.calls).toHaveLength(0);
  });

  it("never lets the operator approve their own party outside demo mode", async () => {
    const api = fakeApi({});
    await expect(
      decideDemoParty(api.deps, owner, "approve"),
    ).rejects.toMatchObject({ code: "demo_only" });
    expect(api.calls).toHaveLength(0);
  });
});

describe("roaming in demo mode", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const k of Object.keys(LIVE_ENV)) delete process.env[k];
    delete process.env.DEMO_MODE;
    resetIvoraForTests();
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  const demoDeps = () => {
    const ocpi = memoryDemoOcpi();
    return {
      ivora: createDemoClient(
        memoryDemoFleet(),
        () => Date.UTC(2026, 9, 22),
        ocpi,
      ),
      demoOcpi: ocpi,
    };
  };
  const demoOwner = staff("owner", true);

  it("goes through request, approval and EVSE IDs without any network call", async () => {
    // The one place that picks the client: demo mode without credentials.
    const picked = getRoaming();
    expect(picked.ivora.mode).toBe("demo");
    expect(picked.demoOcpi).not.toBeNull();
    expect(getIvora().mode).toBe("demo");

    const deps = demoDeps();
    let v = await loadRoaming(deps, demoOwner);
    expect(v.demo).toBe(true);
    expect(v.settings.publish).toBe(false);
    expect(v.settings.party).toMatchObject({ party_id: "IVR", shared: true });
    expect(v.sites.every((s) => s.name.startsWith("Sample"))).toBe(true);

    await saveRoaming(deps, demoOwner, {
      ...FORM,
      revision: v.revision,
      shownLocations: v.sites.map((s) => String(s.id)),
      publishedLocations: [String(v.sites[0].id)],
    });
    v = await loadRoaming(deps, demoOwner);
    expect(v.settings.published).toBe(true);
    expect(v.settings.own_party?.status).toBe("pending_approval");
    expect(v.settings.party.shared).toBe(true);
    expect(v.sites.filter((s) => !s.published)).toHaveLength(
      v.sites.length - 1,
    );
    expect(v.evseIds).toHaveLength(0);

    await decideDemoParty(deps, demoOwner, "reject");
    v = await loadRoaming(deps, demoOwner);
    expect(v.settings.own_party?.status).toBe("rejected");
    expect(v.settings.own_party?.rejection_note).toMatch(/Demo/);

    await decideDemoParty(deps, demoOwner, "approve");
    v = await loadRoaming(deps, demoOwner);
    expect(v.settings.own_party?.status).toBe("approved");
    expect(v.settings.party).toMatchObject({
      country_code: "US",
      party_id: "NTH",
      shared: false,
    });
    expect(v.evseIds.every((e) => e.evse_id.startsWith("US*NTH*E"))).toBe(true);
    expect(v.evseIds[0].stationName).toMatch(/^DEMO-/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers the documented 409 for a party another operator holds", async () => {
    const deps = demoDeps();
    const v = await loadRoaming(deps, demoOwner);
    const e = await saveRoaming(deps, demoOwner, {
      ...FORM,
      revision: v.revision,
      countryCode: DEMO_TAKEN_PARTY.country_code,
      partyId: DEMO_TAKEN_PARTY.party_id,
    }).catch((x) => x);
    expect(e).toMatchObject({ code: "party_in_use" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
