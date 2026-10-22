import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEMO_CODE } from "@/lib/accounts/auth";
import type { CommandView } from "@/lib/commands/manage";
import { syncPeer } from "@/lib/locations/sync";
import { locationAppId } from "@/lib/locations/search";
import { connectToCpo } from "@/lib/ocpi/handshake";
import { stripeApi } from "@/lib/payments/registry";
import { authorizationsAsked, stopLeftoverStart } from "./guards";
import { createHarness, type Harness } from "./harness";
import { laneFromEnv, type Lane } from "./lanes";

// The suite's own safety nets (guards.ts), on the mock CPO: what a misbehaving or
// slow CPO would do to a real run. Mock lane only; a real run skips these.
const MOCK: Lane = { kind: "mock", scenarios: ["rejected"] };

describe.skipIf(laneFromEnv().kind === "real")("OCPI e2e guards", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  /** Registered, locations pulled, one driver signed in with a saved card. */
  async function prepare() {
    h = await createHarness(MOCK, "rejected");
    const peer = await connectToCpo(
      {
        label: h.cpo.label,
        versionsUrl: h.cpo.versionsUrl,
        tokenA: h.cpo.tokenA(),
      },
      { store: h.stores.peers, client: h.client, actor: "e2e" },
    );
    const deps = {
      peers: h.stores.peers,
      locations: h.stores.locations,
      client: h.client,
    };
    for (const module of ["tariffs", "locations"] as const)
      for (let mode: "full" | "auto" = "full"; ; mode = "auto")
        if ((await syncPeer(peer.id, module, deps, { mode })).complete) break;
    const driver = await signIn(h, h.driverEmail);
    const stripe = stripeApi()!;
    const customer = await stripe.createCustomer(
      { email: h.driverEmail, driverRef: driver.id },
      `emsp-e2e:${driver.id}:customer`,
    );
    const now = new Date().toISOString();
    await h.stores.accounts.setCustomer(driver.id, customer.id, now);
    await h.stores.accounts.updateDriver(
      driver.id,
      { defaultPaymentMethodId: await h.attachCard(customer.id) },
      now,
    );
    const role = peer.roles.find((r) => r.role === "CPO")!;
    const appId = locationAppId({
      peerId: peer.id,
      countryCode: role.country_code,
      partyId: role.party_id,
      id: h.target.locationId!,
    });
    return { h, peer, driver, appId };
  }

  async function signIn(h: Harness, email: string) {
    expect(
      (await h.api("POST", "/api/v1/auth/code", { body: { email } })).status,
    ).toBe(202);
    const res = await h.api("POST", "/api/v1/auth/verify", {
      body: { email, code: DEMO_CODE },
    });
    expect(res.status).toBe(200);
    return {
      id: (res.body.driver as { id: string }).id,
      accessToken: (res.body.session as { accessToken: string }).accessToken,
    };
  }

  /** A start the mock CPO takes, though the run expected it refused. */
  async function acceptedStart() {
    const ready = await prepare();
    ready.h.cpo.answerStarts("accepted");
    const res = await ready.h.api("POST", "/api/v1/charges", {
      token: ready.driver.accessToken,
      body: {
        requestId: `e2e-${randomUUID()}`,
        locationId: ready.appId,
        evseUid: ready.h.target.evseUid,
        connectorId: ready.h.target.connectorId,
      },
    });
    expect(res.status).toBe(201);
    const command = res.body.command as CommandView;
    expect(command.status).toBe("accepted");
    return {
      ...ready,
      run: { startId: command.id, accessToken: ready.driver.accessToken },
    };
  }

  it("stops a start the CPO accepted against the scenario, once its session links late", async () => {
    const { h, peer, run } = await acceptedStart();
    // The session arrives only while the cleanup waits for it.
    let ticks = 0;
    const warn = (m: string) => {
      throw new Error(`unexpected instruction: ${m}`);
    };
    const left = await stopLeftoverStart(h, run, {
      warn,
      tick: async () => {
        if (++ticks === 3) await h.cpo.charge();
      },
    });
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(left.outcome).toBe("stopped");
    const sessionId = (left as { sessionId: string }).sessionId;
    const [session] = await h.stores.sessions.findSessions(peer.id, sessionId);
    expect(session.completedAt).toBeTruthy();
    expect(session.commandId).toBe(run.startId);
  });

  it("names the authorization_reference when the session never links", async () => {
    const { h, run } = await acceptedStart();
    const warned: string[] = [];
    const left = await stopLeftoverStart(h, run, {
      timeoutMs: 200,
      warn: (m) => warned.push(m),
    });
    const start = (await h.stores.commands.get(run.startId))!;
    expect(start.authorizationReference).toBeTruthy();
    expect(left.outcome).toBe("left_running");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/Stop it on the CPO side/);
    expect(warned[0]).toContain(
      `authorization_reference ${start.authorizationReference}`,
    );
    expect(warned[0]).toContain(`location ${h.target.locationId}`);
    // Nothing was stopped: no session to stop.
    expect(start.sessionId).toBeNull();
  });

  it("leaves a refused start alone", async () => {
    const ready = await prepare();
    ready.h.cpo.answerStarts("rejected");
    const res = await ready.h.api("POST", "/api/v1/charges", {
      token: ready.driver.accessToken,
      body: {
        requestId: `e2e-${randomUUID()}`,
        locationId: ready.appId,
        evseUid: ready.h.target.evseUid,
      },
    });
    const command = res.body.command as CommandView;
    expect(command.status).toBe("not_supported");
    let ticks = 0;
    const left = await stopLeftoverStart(
      ready.h,
      { startId: command.id, accessToken: ready.driver.accessToken },
      {
        tick: async () => {
          ticks++;
        },
        warn: (m) => {
          throw new Error(m);
        },
      },
    );
    expect(left).toEqual({ outcome: "none" });
    expect(ticks).toBe(0);
    expect(await stopLeftoverStart(ready.h, {})).toEqual({ outcome: "none" });
  });

  it("real-time authorization counts only what the CPO asked about this run's tokens", async () => {
    const { h, driver } = await prepare();
    const [ours] = await h.stores.tokens.listByDriver(driver.id);
    // Another driver's token: the CPO's sandbox may ask about anyone's.
    const other = await signIn(h, "someone-else@example.com");
    const [theirs] = await h.stores.tokens.listByDriver(other.id);
    // (They have no card: NO_CREDIT. Under the old check this alone passed the step.)
    await h.cpo.authorize!(theirs.uid, "APP_USER");
    expect(
      h.stores.peers.auditLog.filter((a) => a.action === "token.authorize"),
    ).toHaveLength(1);
    expect(authorizationsAsked(h, [ours])).toEqual([]);

    await h.cpo.authorize!(ours.uid, "APP_USER");
    expect(authorizationsAsked(h, [ours])).toEqual([
      expect.objectContaining({
        tokenId: ours.id,
        allowed: "ALLOWED",
        type: "APP_USER",
      }),
    ]);
  });
});
