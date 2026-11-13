import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "@/lib/settings";
import { signIvoraBody } from "@/lib/webhook";

// Wiring of the Ivora webhook and the cron sweep to the card-session code. The
// session logic itself is covered in sessions.test.ts; here it is mocked, and the
// test checks what each route calls, with what, and what it answers.

const pending: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    pending.push(Promise.resolve().then(task));
  },
}));

const LIVE_ENV = {
  IVORA_API_KEY: "k",
  IVORA_TENANT_ID: "42",
  STRIPE_SECRET_KEY: "s",
  SESSION_SECRET: "x",
  OPERATOR_PASSWORD: "p",
  PUBLIC_BASE_URL: "https://charge.example.com",
};
const deps = { tag: "live deps" };
const storeDeps = { tag: "store deps" };
const index = { tag: "session index" };
const client = {
  listAllSessions: vi.fn(),
  getSession: vi.fn(),
};

vi.mock("@/lib/server/services", () => ({
  settings: () => readSettings(LIVE_ENV),
  liveDeps: () => deps,
  liveStoreDeps: () => storeDeps,
  ivoraClient: () => client,
  posOutbox: () => null,
}));

const sessions = vi.hoisted(() => ({
  onCardMeterSample: vi.fn(),
  reconcile: vi.fn(),
  sweepUnstartedHolds: vi.fn(),
}));
vi.mock("@/lib/server/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/sessions")>()),
  ...sessions,
}));

const store = vi.hoisted(() => ({
  onMeterSample: vi.fn(),
  reconcileStoreSession: vi.fn(),
  sessionIndex: vi.fn(),
}));
vi.mock("@/lib/server/store", () => store);

const webhook = await import("@/app/api/webhooks/ivora/route");
const cron = await import("@/app/api/cron/reconcile/route");

const WEBHOOK_SECRET = "whsec_test_only";
const CRON_SECRET = "cron_test_only";
const saved = { ...process.env };

beforeEach(() => {
  pending.length = 0;
  for (const fn of [
    ...Object.values(sessions),
    ...Object.values(store),
    ...Object.values(client),
  ])
    fn.mockReset();
  store.sessionIndex.mockReturnValue(index);
  process.env.IVORA_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.IVORA_TENANT_ID = LIVE_ENV.IVORA_TENANT_ID;
  process.env.CRON_SECRET = CRON_SECRET;
});
afterEach(() => {
  process.env = { ...saved };
});

let eventNo = 0;
function ivoraEvent(event: Record<string, unknown>) {
  const body = JSON.stringify({
    id: `evt_${++eventNo}`,
    tenant_id: 42,
    data: {},
    ...event,
  });
  return new Request("https://charge.example.com/api/webhooks/ivora", {
    method: "POST",
    body,
    headers: {
      "ivora-signature": signIvoraBody(
        WEBHOOK_SECRET,
        body,
        Math.floor(Date.now() / 1000),
      ),
    },
  });
}

describe("Ivora webhook: card sessions", () => {
  it("runs the card near-hold check on every meter sample, with no page open", async () => {
    const res = await webhook.POST(
      ivoraEvent({
        type: "meter.sampled",
        resource_id: "21",
        station_id: 7,
        data: { transaction_id: 21 },
      }),
    );
    expect(res.status).toBe(202);
    await Promise.all(pending);
    expect(sessions.onCardMeterSample).toHaveBeenCalledTimes(1);
    expect(sessions.onCardMeterSample).toHaveBeenCalledWith(
      { transactionId: 21, stationId: 7 },
      deps,
      index,
    );
    // Pay in store is off here: its prepaid check does not run.
    expect(store.onMeterSample).not.toHaveBeenCalled();
  });

  it("acknowledges a sample even when the check fails", async () => {
    sessions.onCardMeterSample.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await webhook.POST(
      ivoraEvent({ type: "meter.sampled", station_id: 7 }),
    );
    expect(res.status).toBe(202);
    await Promise.all(pending);
    expect(warn).toHaveBeenCalledWith(
      "[forecourt] card meter sample check failed",
      "Error",
    );
    warn.mockRestore();
  });

  it("refuses an unsigned sample or another tenant's, without checking anything", async () => {
    const unsigned = await webhook.POST(
      new Request("https://charge.example.com/api/webhooks/ivora", {
        method: "POST",
        body: JSON.stringify({
          id: "evt_x",
          type: "meter.sampled",
          tenant_id: 42,
        }),
      }),
    );
    expect(unsigned.status).toBe(401);
    const other = await webhook.POST(
      ivoraEvent({ type: "meter.sampled", tenant_id: 43 }),
    );
    expect(other.status).toBe(400);
    await Promise.all(pending);
    expect(sessions.onCardMeterSample).not.toHaveBeenCalled();
  });
});

const cronRequest = (secret = CRON_SECRET) =>
  new Request("https://charge.example.com/api/cron/reconcile", {
    headers: { authorization: `Bearer ${secret}` },
  });

describe("cron sweep: unstarted card holds", () => {
  it("sweeps holds from the last 8 days after reconciling the session list", async () => {
    client.listAllSessions.mockResolvedValue({
      sessions: [
        {
          id: "ecs_1",
          application_reference: "forecourt:cs_test_a1B2c3D4e5F6g7H8",
          created_at: new Date().toISOString(),
          settlement: null,
        },
      ],
      truncated: false,
    });
    const order: string[] = [];
    sessions.reconcile.mockImplementation(async () => order.push("reconcile"));
    sessions.sweepUnstartedHolds.mockImplementation(async () => {
      order.push("sweep");
      return { released: 2, truncated: false };
    });
    const before = Date.now();
    const res = await cron.GET(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      reconciled: 1,
      holdsReleased: 2,
      failed: [],
      truncated: false,
    });
    expect(order).toEqual(["reconcile", "sweep"]);
    const [sweepDeps, since] = sessions.sweepUnstartedHolds.mock.calls[0];
    expect(sweepDeps).toBe(deps);
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    expect(since).toBeGreaterThanOrEqual(before - eightDays - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - eightDays + 1000);
  });

  it("reports a failed or truncated hold sweep", async () => {
    client.listAllSessions.mockResolvedValue({
      sessions: [],
      truncated: false,
    });
    sessions.sweepUnstartedHolds.mockResolvedValueOnce({
      released: 0,
      truncated: true,
    });
    expect(await (await cron.GET(cronRequest())).json()).toMatchObject({
      truncated: true,
      failed: [],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sessions.sweepUnstartedHolds.mockRejectedValueOnce(
      new Error("stripe down"),
    );
    expect(await (await cron.GET(cronRequest())).json()).toMatchObject({
      holdsReleased: 0,
      failed: ["holds"],
    });
    warn.mockRestore();
  });

  it("does nothing without the cron secret", async () => {
    const res = await cron.GET(cronRequest("wrong"));
    expect(res.status).toBe(401);
    expect(client.listAllSessions).not.toHaveBeenCalled();
    expect(sessions.sweepUnstartedHolds).not.toHaveBeenCalled();
  });
});
