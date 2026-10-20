import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIvora, setIvora } from "@/lib/ivora";
import { getDepot, replan, type Depot } from "@/lib/depot";
import { handleEvent, matchVehicle } from "@/lib/events";
import type { IvoraEvent } from "@/lib/webhook";
import { fakeFetch, liveEnv, type Call } from "./support/fake-api";

/**
 * Live mode end to end against a fake Ivora API (no network): a vehicle plugs in,
 * gets a session charging profile within the site cap, the station's answer
 * arrives by webhook, and the session ends when the connector frees up.
 */

const DEPART_H = 10;
let d: Depot;
let failProfiles = 0;
let txActive = true;
const api = fakeFetch((c: Call) => {
  const path = c.url.replace("https://api.ivoracharge.com/v1/tenants/7", "");
  if (c.method === "GET" && path === "/transactions/31")
    return {
      json: {
        id: 31,
        station_id: 12,
        connector_id: 121,
        connector_number: 1,
        id_token: "****B2C3",
        active: txActive,
        started_at: new Date().toISOString(),
        meter_start_wh: 1000,
        energy_wh: txActive ? null : 9000,
      },
    };
  if (c.method === "GET" && path === "/transactions/32")
    return {
      json: {
        id: 32,
        station_id: 12,
        connector_id: 122,
        connector_number: 2,
        id_token: "****9999",
        active: true,
        meter_start_wh: 0,
      },
    };
  if (c.method === "GET" && path === "/stations/12")
    return {
      json: {
        id: 12,
        name: "depot-01",
        protocol: "ocpp1.6",
        connectors: [
          { id: 121, number: 1, max_power_w: 11000 },
          { id: 122, number: 2, max_power_w: 22000 },
        ],
      },
    };
  if (c.method === "POST" && path === "/stations/12/charging-profiles") {
    if (failProfiles > 0) {
      failProfiles--;
      return {
        status: 503,
        json: {
          error: { code: "outcome_unknown", message: "?" },
          request_id: "r",
        },
      };
    }
    // One profile ID per idempotency key: fd-profile-tx-31-1 -> chp_31-1.
    const id = c.headers["idempotency-key"].replace("fd-profile-tx-", "chp_");
    return {
      status: 202,
      json: {
        id: `op_${id}`,
        status: "succeeded",
        result: { profile_id: id, charger_status: null },
      },
    };
  }
  if (c.method === "POST" && path === "/stations/12/composite-schedule")
    return {
      status: 202,
      json: {
        id: "op_c",
        status: "succeeded",
        result: {
          schedule: {
            unit: "W",
            periods: [{ start_offset_seconds: 0, limit: 3000 }],
          },
        },
      },
    };
  return {
    status: 404,
    json: { error: { code: "not_found", message: path }, request_id: "r" },
  };
});

const evt = (type: string, data: Record<string, unknown>): IvoraEvent => ({
  id: `evt_${Math.random()}`,
  type,
  tenant_id: 7,
  data,
});
const profilePosts = () =>
  api.calls.filter(
    (c) => c.url.endsWith("/charging-profiles") && c.method === "POST",
  );

beforeAll(async () => {
  liveEnv();
  process.env.SQLITE_PATH = join(
    mkdtempSync(join(tmpdir(), "fleet-depot-")),
    "t.db",
  );
  (globalThis as { __depot?: unknown }).__depot = undefined;
  setIvora(
    createIvora({
      baseUrl: "https://api.ivoracharge.com",
      apiKey: "iv_test_not_a_real_key",
      tenantId: "7",
      fetch: api.fetch,
      sleep: async () => {},
    }),
  );
  d = await getDepot();
  expect(d.demo).toBe(false);
  d.settings.siteCapKw = 5;
  await d.store.put("drivers", "d1", {
    id: "d1",
    name: "Test Driver",
    idTag: "04A1B2C3",
    cardBlocked: false,
  });
  await d.store.put("vehicles", "v1", {
    id: "v1",
    name: "Van 1",
    plate: "TEST-1",
    kind: "van",
    batteryKwh: 75,
    maxKw: 11,
    driverId: "d1",
    departure: new Date(Date.now() + DEPART_H * 3600_000).toISOString(),
    need: { kind: "kwh", kwh: 30 },
  });
});

describe("matching a masked card", () => {
  const drivers = [
    { id: "a", idTag: "04A1B2C3" },
    { id: "b", idTag: "FFFF0001" },
    { id: "c", idTag: "EEEE0001" },
  ];
  const vehicles = [
    { id: "va", driverId: "a" },
    { id: "vb", driverId: "b" },
  ];
  it("matches the last 4 characters, case-insensitively", () =>
    expect(matchVehicle("****b2c3", drivers, vehicles)).toBe("va"));
  it("leaves ambiguous or unknown cards unmatched", () => {
    expect(matchVehicle("****0001", drivers, vehicles)).toBeUndefined();
    expect(matchVehicle("****9999", drivers, vehicles)).toBeUndefined();
    expect(matchVehicle(null, drivers, vehicles)).toBeUndefined();
  });
});

describe("live session lifecycle (fake API)", () => {
  it("starts a session from the first meter sample and sends a session profile in W", async () => {
    await handleEvent(
      d,
      evt("meter.sampled", {
        transaction_id: 31,
        connector_id: 121,
        energy_wh: 1500,
        soc_percent: "40.5",
      }),
    );
    const [s] = await d.store.list("sessions");
    expect(s).toMatchObject({
      id: "tx-31",
      vehicleId: "v1",
      transactionId: 31,
      connectorKw: 11,
      meterStartWh: 1000,
      meterWh: 1500,
      reportedSocPercent: 40.5,
    });
    // 30 kWh in 10 h is 3 kW, under the 5 kW cap.
    expect(s.allocatedKw).toBeCloseTo(3, 1);
    expect(s.profile).toMatchObject({
      status: "pending",
      profileId: "chp_31-1",
      key: "fd-profile-tx-31-1",
      composite: "3000 W now",
    });
    const post = profilePosts()[0];
    expect(post.headers["idempotency-key"]).toBe("fd-profile-tx-31-1");
    const body = JSON.parse(post.body!);
    expect(body).toMatchObject({
      purpose: "session",
      unit: "W",
      transaction_id: 31,
      kind: "absolute",
    });
    // No duration: the profile never expires into an unlimited charger.
    expect(body).not.toHaveProperty("duration_seconds");
    expect(body.periods[0].limit).toBeGreaterThan(2990);
    // Rounded up to finish by departure, then held as the session's whole-watt share.
    expect(body.periods[0].limit).toBeLessThanOrEqual(3001);
    expect(
      Math.max(...body.periods.map((p: { limit: number }) => p.limit)),
    ).toBe(Math.round(s.allocatedKw * 1000));
  });

  it("records the station's answer from charging_profile.accepted", async () => {
    await handleEvent(
      d,
      evt("charging_profile.accepted", {
        profile: { id: "chp_31-1", status: "accepted" },
        station_id: 12,
        charger_status: "Accepted",
      }),
    );
    expect((await d.store.list("sessions"))[0].profile?.status).toBe(
      "accepted",
    );
  });

  it("does not resend when the plan is unchanged", async () => {
    const n = profilePosts().length;
    await replan(d);
    expect(profilePosts().length).toBe(n);
  });

  it("splits the cap when a second (unmatched) vehicle plugs in, earliest departure first", async () => {
    await handleEvent(
      d,
      evt("meter.sampled", {
        transaction_id: 32,
        connector_id: 122,
        energy_wh: 0,
      }),
    );
    const sessions = await d.store.list("sessions");
    const total = sessions.reduce((a, s) => a + s.allocatedKw, 0);
    expect(total).toBeLessThanOrEqual(5 + 1e-9);
    const unmatched = sessions.find((s) => s.id === "tx-32")!;
    expect(unmatched.vehicleId).toBeUndefined();
    const van = sessions.find((s) => s.id === "tx-31")!;
    // The unmatched session departs "never", so it gets what Van 1 leaves.
    expect(unmatched.allocatedKw).toBeCloseTo(5 - van.allocatedKw, 3);
    expect(unmatched.profile?.key).toBe("fd-profile-tx-32-1");
  });

  it("retries a failed send with the same key and body", async () => {
    d.settings.siteCapKw = 4; // forces a new plan for tx-32
    failProfiles = 4; // exhausts the client's attempts once
    await replan(d);
    let s = (await d.store.list("sessions")).find((x) => x.id === "tx-32")!;
    expect(s.profile).toMatchObject({
      status: "error",
      key: "fd-profile-tx-32-2",
    });
    // The outcome is unknown, so it stays counted until it is resolved.
    expect(s.sent?.at(-1)?.key).toBe("fd-profile-tx-32-2");
    expect(s.sent?.at(-1)?.profileId).toBeUndefined();
    const failed = profilePosts().slice(-4);
    expect(new Set(failed.map((c) => c.headers["idempotency-key"]))).toEqual(
      new Set(["fd-profile-tx-32-2"]),
    );
    await replan(d);
    s = (await d.store.list("sessions")).find((x) => x.id === "tx-32")!;
    expect(s.profile).toMatchObject({
      status: "pending",
      key: "fd-profile-tx-32-2",
    });
    const last = profilePosts().at(-1)!;
    expect(last.headers["idempotency-key"]).toBe("fd-profile-tx-32-2");
    expect(last.body).toBe(failed[0].body);
  });

  it("ends the session when the connector frees up and the transaction reads inactive", async () => {
    txActive = false;
    await handleEvent(
      d,
      evt("connector.status_changed", {
        connector_id: 121,
        status: "Available",
        previous_status: "Charging",
      }),
    );
    expect((await d.store.list("sessions")).map((s) => s.id)).toEqual([
      "tx-32",
    ]);
    const tx = (await d.store.list("transactions")).find(
      (t) => t.id === "tx-31",
    )!;
    expect(tx).toMatchObject({
      vehicleId: "v1",
      driverId: "d1",
      meterStartWh: 1000,
      meterStopWh: 10000,
    });
  });

  it("deduplicates webhook deliveries by event ID", async () => {
    expect(
      await d.store.claim("webhookEvents", "evt_same", {
        id: "evt_same",
        at: "",
      }),
    ).toBe(true);
    expect(
      await d.store.claim("webhookEvents", "evt_same", {
        id: "evt_same",
        at: "",
      }),
    ).toBe(false);
  });
});
