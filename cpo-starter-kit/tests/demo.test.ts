import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIvora,
  idempotencyKey,
  resetIvoraForTests,
} from "@/lib/server/ivora";
import { createLiveClient } from "@/lib/server/ivora/live";
import { isDemo } from "@/lib/server/env";
import { loadOverview } from "@/lib/server/overview";
import { getLive } from "@/lib/server/live";
import { resetDemoLiveForTests } from "@/lib/server/live/demo-cookie";
import { loadLive, loadStation, sendCommand } from "@/lib/server/live/service";
import type { Staff } from "@/lib/server/team/types";
import {
  createDemoOnboardingStore,
  memoryDemoOnboarding,
} from "@/lib/server/onboarding/demo";
import {
  loadOnboarding,
  loadStripe,
  saveBrand,
  saveCompany,
  syncBranding,
} from "@/lib/server/onboarding/service";

const VARS = [
  "IVORA_API_KEY",
  "IVORA_TENANT_ID",
  "DEMO_MODE",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];
const SUPABASE = {
  SUPABASE_URL: "https://supabase.example.test",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

describe("demo mode", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of VARS) delete process.env[k];
    resetIvoraForTests();
    resetDemoLiveForTests();
    // Demo mode must never reach the network: any fetch fails the test.
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("is on when credentials are missing or empty, and can be forced", () => {
    expect(isDemo()).toBe(true);
    process.env.IVORA_API_KEY = "test-key";
    expect(isDemo()).toBe(true);
    process.env.IVORA_TENANT_ID = "  ";
    expect(isDemo()).toBe(true);
    process.env.IVORA_TENANT_ID = "42";
    // Live charger data needs staff sign-in, so Supabase is required too.
    expect(isDemo()).toBe(true);
    Object.assign(process.env, SUPABASE);
    expect(isDemo()).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "";
    expect(isDemo()).toBe(true);
    Object.assign(process.env, SUPABASE);
    process.env.DEMO_MODE = "true";
    expect(isDemo()).toBe(true);
  });

  it("runs every client method on labelled sample data without any network call", async () => {
    const ivora = getIvora();
    expect(ivora.mode).toBe("demo");

    const stations = await ivora.listStations();
    expect(stations.length).toBeGreaterThan(0);
    expect(stations.every((s) => s.name.startsWith("DEMO-"))).toBe(true);
    expect((await ivora.getStation(stations[0].id)).id).toBe(stations[0].id);
    await expect(ivora.getStation(1)).rejects.toMatchObject({
      code: "station_not_found",
    });

    const locations = await ivora.listLocations();
    expect(locations.every((l) => l.name.startsWith("Sample"))).toBe(true);
    const key = idempotencyKey("location", "site-1", "create");
    const input = { name: "Depot", external_reference: "cpo-site-1" };
    const a = await ivora.createLocation(input, key);
    expect(a.name).toBe("Sample Site: Depot");
    // Same key, same record: a retry does not create a second location.
    expect((await ivora.createLocation(input, key)).id).toBe(a.id);
    expect(await ivora.listLocations()).toHaveLength(locations.length + 1);

    expect((await ivora.listTransactions()).length).toBeGreaterThan(0);
    expect((await ivora.listAllStations()).data).toHaveLength(stations.length);
    expect((await ivora.listAllLocations()).truncated).toBe(false);

    const r = await loadOverview();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overview.mode).toBe("demo");

    const branding = await ivora.putBranding(
      {
        display_name: "Sample Co",
        primary_color: "#17613a",
        support_email: null,
        support_url: null,
      },
      idempotencyKey("branding", "demo", "put-0"),
    );
    expect(branding.display_name).toBe("Sample Co");
    // Demo mode keeps no logo: the upload is refused, never sent.
    await expect(
      ivora.putBrandingLogo(
        { bytes: new Uint8Array(8), contentType: "image/png" },
        idempotencyKey("logo", "demo", "put-0"),
      ),
    ).rejects.toMatchObject({ code: "demo_logo_not_stored" });
    expect((await ivora.getPaymentAccount()).status).toBe("none");

    // Chargers: registering, passwords, commands and deletes are simulated.
    const st = await ivora.createStation(
      {
        name: "DEMO-NEW-01",
        location_id: a.id,
        connectors: 1,
        external_reference: "cpo-charger-x",
      },
      idempotencyKey("charger", "x", "create"),
    );
    expect(st.connection_url).toMatch(/^wss:\/\/ocpp\.demo\.example\//);
    const op = await ivora.setCredentials(
      st.id,
      "A".repeat(24),
      idempotencyKey("credentials", "x", "set-1"),
    );
    expect(op.status).toBe("succeeded");
    expect((await ivora.getOperation(op.id)).status).toBe("succeeded");
    await expect(
      ivora.sendCommand(
        st.id,
        {
          action: "start",
          connector_id: st.connectors[0].id,
          token: "T",
          token_type: "Central",
        },
        idempotencyKey("charger", "x", "test-1-start"),
      ),
    ).rejects.toMatchObject({ code: "station_offline" });
    await ivora.updateStation(
      st.id,
      { location_id: 9001 },
      idempotencyKey("charger", "x", "move-1"),
    );
    await ivora.deleteStation(st.id, idempotencyKey("charger", "x", "delete"));
    await expect(ivora.getStation(st.id)).rejects.toMatchObject({
      code: "station_not_found",
    });
    expect((await ivora.getTransaction(9201)).id).toBe(9201);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs onboarding end to end (company, brand, logo, Stripe) without any network call", async () => {
    const d = {
      store: createDemoOnboardingStore(memoryDemoOnboarding()),
      ivora: getIvora(),
    };
    const owner = {
      userId: "demo-owner",
      email: "demo-owner@example.com",
      role: "owner" as const,
      operatorId: "demo-operator",
      operatorName: "Sample Operator",
      demo: true,
    };
    await saveCompany(d, owner, {
      name: "Sample Charging Co",
      supportEmail: "help@example.com",
      supportUrl: "",
      website: "",
      timeZone: "UTC",
      currency: "USD",
    });
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    png.set([0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 64], 12);
    const r = await saveBrand(d, owner, { primaryColor: "#17613a", logo: png });
    expect(r.logo).toEqual({ state: "demo" });
    expect(await syncBranding(d, owner, { force: true })).toEqual({
      state: "synced",
    });
    const o = await loadOnboarding(d, owner);
    expect(o.companyDone && o.brandDone).toBe(true);
    for (const s of ["none", "pending", "pending_review", "ready"] as const) {
      await d.store.setDemoStripe!(s);
      const stripe = await loadStripe(d);
      expect(stripe.ok && stripe.view.state).toBe(s);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs the Live view end to end (map, faults, stop, unlock, reset) without any network call", async () => {
    const d = getLive();
    expect(d.store.mode).toBe("demo");
    expect(d.ivora.mode).toBe("demo");
    const tech: Staff = {
      userId: "00000000-0000-4000-8000-0000000000d1",
      email: "demo-tech@example.com",
      role: "technician",
      operatorId: "demo",
      operatorName: "Demo",
      demo: true,
    };
    const r = await loadLive(d, tech);
    if (!r.ok) throw new Error(r.error);
    // Sample sites sit at made-up coordinates; one open sample fault, one session.
    expect(r.live.points.length).toBeGreaterThan(0);
    expect(r.live.faults).toMatchObject([
      { stationName: "DEMO-HARBOUR-02", errorCode: "GroundFailure" },
    ]);
    const [session] = r.live.sessions;
    expect(session).toMatchObject({ stationName: "DEMO-HARBOUR-02" });
    const detail = await loadStation(d, tech, session.stationId);
    expect(detail.ok && detail.detail?.faults.length).toBeGreaterThan(0);

    const rid = (n: number) => `50000000-0000-4000-8000-00000000000${n}`;
    // Stop the sample session: it needs the session named.
    await expect(
      sendCommand(d, tech, {
        requestId: rid(1),
        stationId: session.stationId,
        action: "stop",
        transactionId: session.id,
        confirmed: true,
        sessions: [],
      }),
    ).rejects.toMatchObject({ code: "confirm" });
    const stop = await sendCommand(d, tech, {
      requestId: rid(2),
      stationId: session.stationId,
      action: "stop",
      transactionId: session.id,
      confirmed: true,
      sessions: [session.id],
    });
    expect(stop.phase).toBe("accepted");
    const after = await loadLive(d, tech);
    expect(after.ok && after.live.sessions).toEqual([]);
    expect(after.ok && after.live.commands[0].observed).toBe(
      `Session ${session.id} ended.`,
    );
    // A reset clears the sample fault once the charger is back.
    const reset = await sendCommand(d, tech, {
      requestId: rid(3),
      stationId: session.stationId,
      action: "reset",
      mode: "soft",
      confirmed: true,
      sessions: [],
    });
    expect(reset.phase).toBe("accepted");
    const cleared = await loadStation(d, tech, session.stationId);
    expect(cleared.ok && cleared.detail?.faults.every((f) => !f.open)).toBe(
      true,
    );
    // A remote start registers the demo staff token (in the cookie) and its session
    // is labelled as a staff session.
    const start = await sendCommand(d, tech, {
      requestId: rid(4),
      stationId: 9101,
      action: "start",
      connectorId: 91011,
      confirmed: true,
      sessions: [],
    });
    expect(start.phase).toBe("accepted");
    const started = await loadLive(d, tech);
    expect(started.ok && started.live.sessions).toMatchObject([
      { stationId: 9101, staff: true },
    ]);
    expect(started.ok && started.live.commands[0].observed).toMatch(
      /^Session \d+ started\.$/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves demo even with credentials when DEMO_MODE is forced", async () => {
    process.env.IVORA_API_KEY = "test-key";
    process.env.IVORA_TENANT_ID = "42";
    Object.assign(process.env, SUPABASE);
    process.env.DEMO_MODE = "1";
    expect(getIvora().mode).toBe("demo");
    await getIvora().listStations();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a live client refuses to send while demo mode is on", async () => {
    const liveFetch = vi.fn(async () => Response.json({ data: [] }));
    const live = createLiveClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      tenantId: "42",
      fetch: liveFetch,
    });
    await expect(live.listStations()).rejects.toThrow(/Demo mode/);
    await expect(
      live.createLocation(
        { name: "X", external_reference: "cpo-site-x" },
        idempotencyKey("location", "x", "create"),
      ),
    ).rejects.toThrow(/Demo mode/);
    await expect(live.getPaymentAccount()).rejects.toThrow(/Demo mode/);
    await expect(
      live.putBranding(
        {
          display_name: "X",
          primary_color: null,
          support_email: null,
          support_url: null,
        },
        idempotencyKey("branding", "x", "put-0"),
      ),
    ).rejects.toThrow(/Demo mode/);
    for (const call of [
      () =>
        live.createStation(
          {
            name: "X-1",
            location_id: 1,
            connectors: 1,
            external_reference: "cpo-charger-x",
          },
          idempotencyKey("charger", "x", "create"),
        ),
      () =>
        live.setCredentials(
          1,
          "A".repeat(24),
          idempotencyKey("credentials", "x", "set-1"),
        ),
      () =>
        live.sendCommand(
          1,
          { action: "stop", transaction_id: 1 },
          idempotencyKey("charger", "x", "test-1-stop"),
        ),
      () => live.deleteStation(1, idempotencyKey("charger", "x", "delete")),
    ])
      await expect(call()).rejects.toThrow(/Demo mode/);
    expect(liveFetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
