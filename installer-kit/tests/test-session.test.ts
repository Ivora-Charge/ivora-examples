import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, TransactionSnapshot } from "@/lib/server/backend";
import { HttpError, IvoraError } from "@/lib/server/errors";
import {
  addCharger,
  createSite,
  refresh,
  markInService,
  setBackendForTests,
  startTest,
  stopTest,
} from "@/lib/server/service";
import { resetStoreForTests } from "@/lib/server/store";
import { demoBackend } from "@/lib/server/demo-backend";

const NOW = Date.UTC(2026, 9, 19, 12);
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const tx = (over: Partial<TransactionSnapshot> = {}): TransactionSnapshot => ({
  transactionId: "900",
  active: true,
  startedAt: iso(5_000),
  endedAt: null,
  energyWh: 0,
  connectorResourceId: "c1",
  idToken: "****TEST",
  ...over,
});

/** A scripted charger: tests set `sessions` and `startError`. */
function fakeBackend() {
  const state = {
    sessions: [] as TransactionSnapshot[],
    startError: null as unknown,
    connectorStatus: null as string | null,
    starts: [] as string[],
    stops: [] as { transactionId: string; key: string }[],
  };
  const backend: Backend = {
    ...demoBackend,
    demo: false,
    async createLocation() {
      return "loc";
    },
    async createStation() {
      return {
        stationId: "st",
        connectionUrl: "wss://x.invalid",
        username: "u",
      };
    },
    async setPassword() {},
    async getStation() {
      return {
        state: "booted",
        boot: { vendor: "Acme", model: "AC-7", firmware: null },
        connectors: [
          { resourceId: "c1", number: 1, status: state.connectorStatus },
        ],
      };
    },
    async startCharging(_s, _c, key) {
      state.starts.push(key);
      if (state.startError) throw state.startError;
    },
    async findTransaction(_s, connector, since) {
      const mine = state.sessions.filter(
        (t) =>
          t.connectorResourceId === connector &&
          t.idToken === "****TEST" &&
          Date.parse(t.startedAt ?? "") >= Date.parse(since),
      );
      return mine[mine.length - 1] ?? null;
    },
    async hasActiveTransaction(_s, connector) {
      return state.sessions.some(
        (t) => t.active && t.connectorResourceId === connector,
      );
    },
    async getTransaction(id) {
      const t = state.sessions.find((x) => x.transactionId === id);
      if (!t) throw new HttpError(404, "not_found", "Unknown.");
      return t;
    },
    async stopCharging(_s, transactionId, key) {
      state.stops.push({ transactionId, key });
      const t = state.sessions.find((x) => x.transactionId === transactionId)!;
      t.active = false;
      t.endedAt = new Date().toISOString();
    },
  };
  return { state, backend };
}

async function setup() {
  const site = await createSite({ name: "Site", address: "1 Main St" });
  const { charger } = await addCharger({
    siteId: site.id,
    name: "ik-test-1",
    connectors: 1,
  });
  return charger.id;
}

describe("test session start and stop", () => {
  let fake: ReturnType<typeof fakeBackend>;
  let id: string;

  beforeEach(async () => {
    resetStoreForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fake = fakeBackend();
    setBackendForTests(fake.backend);
    id = await setup();
  });
  afterEach(() => {
    setBackendForTests(null);
    vi.useRealTimers();
  });

  const timeout = () => new IvoraError(503, "network_error", "No answer.");

  it.each([
    ["a timeout", () => timeout()],
    [
      "outcome_unknown",
      () => new IvoraError(503, "outcome_unknown", "Unknown outcome."),
    ],
    [
      "request_in_progress",
      () => new IvoraError(409, "request_in_progress", "In progress."),
    ],
  ])("keeps the test stoppable after %s", async (_n, makeError) => {
    fake.state.startError = makeError();
    await expect(startTest(id, 1)).rejects.toBeDefined();
    let c = await refresh(id);
    expect(c.test).toMatchObject({ phase: "starting" });
    expect(c.test?.errorCode).toBeUndefined();

    // The command did reach the charger: the session appears.
    vi.setSystemTime(NOW + 10_000);
    fake.state.sessions.push(tx());
    c = await refresh(id);
    expect(c.test).toMatchObject({ phase: "charging", transactionId: "900" });

    c = await stopTest(id);
    expect(fake.state.stops).toEqual([
      { transactionId: "900", key: `${id}:test:1:stop` },
    ]);
    expect(c.test?.phase).toBe("done");
  });

  it("fails an uncertain start only when no session shows up in time", async () => {
    fake.state.startError = timeout();
    await expect(startTest(id, 1)).rejects.toBeDefined();
    vi.setSystemTime(NOW + 3 * 60_000);
    const c = await refresh(id);
    expect(c.test).toMatchObject({
      phase: "failed",
      errorCode: "no_transaction",
    });
  });

  it("fails at once on a definite refusal", async () => {
    fake.state.startError = new IvoraError(409, "rejected", "No.", null, true);
    await expect(startTest(id, 1)).rejects.toBeDefined();
    expect((await refresh(id)).test).toMatchObject({
      phase: "failed",
      passed: false,
      errorCode: "rejected",
    });

    fake.state.startError = new HttpError(
      409,
      "start_not_accepted",
      "Rejected.",
    );
    await expect(startTest(id, 1)).rejects.toBeDefined();
    expect((await refresh(id)).test).toMatchObject({
      phase: "failed",
      errorCode: "start_not_accepted",
    });
  });

  it("never adopts or stops a driver's session", async () => {
    await startTest(id, 1);
    vi.setSystemTime(NOW + 10_000);
    // Another token, a session before the request, and another connector.
    fake.state.sessions.push(
      tx({ transactionId: "901", idToken: "****1234" }),
      tx({ transactionId: "902", startedAt: iso(-60_000) }),
      tx({ transactionId: "903", connectorResourceId: "c2" }),
    );
    const c = await refresh(id);
    expect(c.test).toMatchObject({ phase: "starting" });
    expect(c.test?.transactionId).toBeUndefined();
    await expect(stopTest(id)).rejects.toMatchObject({ code: "not_started" });
    expect(fake.state.stops).toEqual([]);
  });

  it("refuses to start while the connector is busy", async () => {
    fake.state.sessions.push(
      tx({ idToken: "****1234", startedAt: iso(-1000) }),
    );
    await expect(startTest(id, 1)).rejects.toMatchObject({
      code: "connector_busy",
    });
    fake.state.sessions.length = 0;
    fake.state.connectorStatus = "Charging";
    await expect(startTest(id, 1)).rejects.toMatchObject({
      code: "connector_busy",
    });
    expect(fake.state.starts).toEqual([]);
    fake.state.connectorStatus = "Preparing";
    await startTest(id, 1);
    expect(fake.state.starts).toHaveLength(1);
  });

  it("sends one command for a double start", async () => {
    fake.state.startError = timeout();
    await expect(startTest(id, 1)).rejects.toBeDefined();
    await expect(startTest(id, 1)).rejects.toMatchObject({
      code: "test_running",
    });
    expect(fake.state.starts).toEqual([`${id}:test:1:start`]);
  });

  it("sends one command for two simultaneous starts", async () => {
    const results = await Promise.allSettled([
      startTest(id, 1),
      startTest(id, 1),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fake.state.starts).toHaveLength(1);
  });

  it("refuses a test start once the charger is marked in service", async () => {
    const c = markInService(id);
    expect(c.inServiceAt).toBe(iso(0));
    // Repeating it keeps the first time.
    vi.setSystemTime(NOW + 5_000);
    expect(markInService(id).inServiceAt).toBe(iso(0));
    // A stale page that still shows the Start button gets a 409.
    await expect(startTest(id, 1)).rejects.toMatchObject({
      status: 409,
      code: "in_service",
    });
    expect(fake.state.starts).toEqual([]);
  });

  it("will not mark in service while a test is running", async () => {
    await startTest(id, 1);
    expect(() => markInService(id)).toThrowError(
      expect.objectContaining({ code: "test_running" }),
    );
  });
});
