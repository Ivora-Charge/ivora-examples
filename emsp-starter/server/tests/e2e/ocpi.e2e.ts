import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
} from "vitest";
import { randomUUID } from "node:crypto";
import { DEMO_CODE } from "@/lib/accounts/auth";
import type { CommandView } from "@/lib/commands/manage";
import { locationAppId, type LocationDetail } from "@/lib/locations/search";
import { syncPeer } from "@/lib/locations/sync";
import { ocpiRequest } from "@/lib/ocpi/client";
import { connectToCpo, unregisterPeer } from "@/lib/ocpi/handshake";
import type { Peer } from "@/lib/ocpi/store";
import { parseToken } from "@/lib/ocpi/token-objects";
import { decryptToken } from "@/lib/ocpi/tokens";
import { cdrAmount } from "@/lib/payments/money";
import { paymentDeps, stripeApi } from "@/lib/payments/registry";
import { refundPayment } from "@/lib/payments/settle";
import { config } from "@/lib/server/config";
import { pullSessions } from "@/lib/sessions/pull";
import { addRfidCard } from "@/lib/tokens/manage";
import { tokensReceiver } from "@/lib/tokens/push";
import type { DriverToken } from "@/lib/tokens/store";
import { createHarness, waitFor, type Harness } from "./harness";
import { laneFromEnv, type ExpectStart } from "./lanes";

/**
 * The OCPI e2e suite: one charging network's eMSP against one CPO, end to end, over
 * OCPI 2.2.1. The same steps run against the mock CPO (CI) and, when configured, any
 * real CPO's sandbox (lanes.ts). Per scenario:
 *
 *  handshake -> locations and tariffs -> driver sign-in and token push -> card ->
 *  START_SESSION -> session updates -> STOP_SESSION -> CDR -> capture -> refund ->
 *  real-time authorization -> unregister
 *
 * Some CPOs disable remote start. With OCPI_E2E_EXPECT_START=rejected (the default)
 * the start must be refused and shown as "remote start not available"; the steps that
 * need a session then skip, saying why. The mock lane runs both scenarios.
 *
 * Later parts add their own steps to this list: the admin web's pages over the same
 * run, and the optional live-data adapter behind its own switch. Anything that differs
 * between CPOs goes in `CpoSide` (harness.ts), never in a step.
 */
const lane = laneFromEnv();

/** Wording the app shows for a charger that refuses app starts (lib/commands). */
const REMOTE_START_UNAVAILABLE = /doesn't accept app starts/i;

for (const scenario of lane.scenarios) describeScenario(scenario);

function describeScenario(scenario: ExpectStart) {
  describe(`OCPI e2e, ${lane.kind} CPO, remote start ${scenario}`, () => {
    let h: Harness;
    const run: {
      peer?: Peer;
      accessToken?: string;
      driverId?: string;
      appToken?: DriverToken;
      rfid?: DriverToken;
      card?: string;
      location?: { appId: string; evseUid?: string; connectorId?: string };
      startId?: string;
      sessionId?: string;
      sessionCompleted?: boolean;
      cdrMinor?: number;
      paymentId?: string;
      captured?: number;
    } = {};

    /** A later step that needs an earlier one skips, naming it, when that one failed. */
    function need<T>(ctx: TestContext, value: T | undefined, what: string): T {
      if (value === undefined || value === null)
        ctx.skip(`needs ${what}, which did not pass`);
      return value as T;
    }

    /** Sessions and CDRs, pulled for CPOs that only offer GET (real lane). */
    const pull = async () => {
      if (h.lane !== "real" || !run.peer) return;
      for (const module of ["sessions", "cdrs"] as const) {
        if (
          !run.peer.endpoints.some(
            (e) => e.identifier === module && e.role === "SENDER",
          )
        )
          continue;
        await pullSessions(run.peer.id, module, {
          ...h.stores,
          syncState: h.stores.locations,
          client: h.client,
        }).catch((e) =>
          console.error(
            `Pulling ${module} failed: ${e instanceof Error ? e.message : "unknown error"}`,
          ),
        );
      }
    };

    const charge = async (id: string) => {
      const res = await h.api("GET", `/api/v1/charges/${id}`, {
        token: run.accessToken,
      });
      expect(res.status).toBe(200);
      return res.body as {
        command: CommandView;
        payment: Record<string, unknown> | null;
      };
    };

    /** Routing headers from us to the CPO's first CPO party. */
    const routing = () => {
      const role = run.peer!.roles.find((r) => r.role === "CPO")!;
      return {
        from: { countryCode: config.countryCode, partyId: config.partyId },
        to: { countryCode: role.country_code, partyId: role.party_id },
      };
    };

    /** A token as the CPO's Tokens Receiver holds it (GET, OCPI 2.2.1). */
    const tokenAtCpo = async (t: DriverToken) => {
      const receiver = tokensReceiver(run.peer!);
      const res = await ocpiRequest(
        {
          url: `${receiver}/${t.countryCode}/${t.partyId}/${encodeURIComponent(t.uid)}`,
          query: { type: t.type },
          token: decryptToken(run.peer!.tokenCiphertext!, run.peer!.id),
          routing: routing(),
        },
        h.client,
      );
      const parsed = parseToken(res.data);
      expect(parsed.ok, "the CPO's copy is a valid 2.2.1 Token").toBe(true);
      return parsed.ok ? parsed.value : undefined;
    };

    beforeAll(async () => {
      h = await createHarness(lane, scenario);
    });

    afterAll(async () => {
      if (!h) return;
      try {
        // A real charger must never be left charging by a failed run.
        if (h.lane === "real" && run.sessionId && !run.sessionCompleted)
          await h
            .api("POST", `/api/v1/charges/${run.startId}/stop`, {
              token: run.accessToken,
              body: { requestId: `e2e-cleanup-${randomUUID()}` },
            })
            .catch(() => undefined);
        const peer = run.peer && (await h.stores.peers.getPeer(run.peer.id));
        if (peer?.status === "registered" && !h.keepRegistration)
          await unregisterPeer(peer.id, {
            store: h.stores.peers,
            client: h.client,
            actor: "e2e",
          }).catch(() => undefined);
      } finally {
        await h.close();
      }
    });

    it("our OCPI endpoints answer where the CPO calls them", async () => {
      // No token: refused with an OCPI envelope, from wherever the CPO reaches us.
      const res = await h.fetchOurs("/ocpi/versions");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { status_code?: unknown };
      expect(typeof body.status_code).toBe("number");
      if (h.lane === "real")
        expect(h.inbound.some((r) => r.path === "/ocpi/versions")).toBe(true);
    });

    it("handshake: registers at the CPO with its Token A", async () => {
      const peer = await connectToCpo(
        {
          label: h.cpo.label,
          versionsUrl: h.cpo.versionsUrl,
          tokenA: h.cpo.tokenA(),
        },
        { store: h.stores.peers, client: h.client, actor: "e2e" },
      );
      expect(peer.status).toBe("registered");
      expect(peer.version).toBe("2.2.1");
      expect(peer.roles.some((r) => r.role === "CPO")).toBe(true);
      const has = (identifier: string, role: "SENDER" | "RECEIVER") =>
        peer.endpoints.some(
          (e) => e.identifier === identifier && e.role === role,
        );
      expect(has("locations", "SENDER"), "a locations Sender").toBe(true);
      expect(has("tokens", "RECEIVER"), "a tokens Receiver").toBe(true);
      expect(has("commands", "RECEIVER"), "a commands Receiver").toBe(true);
      run.peer = peer;
    });

    it("locations and tariffs: a full pull, then the app's search", async (ctx) => {
      const peer = need(ctx, run.peer, "the handshake");
      const deps = {
        peers: h.stores.peers,
        locations: h.stores.locations,
        client: h.client,
      };
      const pullAll = async (module: "locations" | "tariffs") => {
        let items = 0;
        for (let mode: "full" | "auto" = "full"; ; mode = "auto") {
          const r = await syncPeer(peer.id, module, deps, { mode });
          items += r.items;
          if (r.complete) return items;
        }
      };
      if (
        peer.endpoints.some(
          (e) => e.identifier === "tariffs" && e.role === "SENDER",
        )
      ) {
        const tariffs = await pullAll("tariffs");
        if (h.lane === "mock") expect(tariffs).toBeGreaterThan(0);
      }
      expect(await pullAll("locations")).toBeGreaterThan(0);

      const search = await h.api("GET", "/api/v1/locations?limit=100");
      expect(search.status).toBe(200);
      const items = search.body.items as { id: string }[];
      expect(items.length).toBeGreaterThan(0);

      run.location = await chooseLocation(peer, items);
      const detail = await h.api(
        "GET",
        `/api/v1/locations/${run.location.appId}`,
      );
      expect(detail.status).toBe(200);
      const evses = (detail.body.location as LocationDetail).evses;
      expect(evses.length).toBeGreaterThan(0);
      if (h.lane === "mock")
        // The mock's tariffs reach the app as display prices.
        expect(
          evses.flatMap((e) => e.connectors).some((c) => c.price !== null),
        ).toBe(true);
    });

    /** The configured location, else the first with an EVSE that takes remote starts. */
    async function chooseLocation(peer: Peer, items: { id: string }[]) {
      const t = h.target;
      if (t.locationId) {
        for (const role of peer.roles.filter((r) => r.role === "CPO")) {
          const key = {
            peerId: peer.id,
            countryCode: role.country_code,
            partyId: role.party_id,
            id: t.locationId,
          };
          if (await h.stores.locations.getLocation(key))
            return {
              appId: locationAppId(key),
              evseUid: t.evseUid,
              connectorId: t.connectorId,
            };
        }
        throw new Error(
          "OCPI_E2E_LOCATION_ID is not among the locations the CPO sent",
        );
      }
      for (const item of items) {
        const detail = await h.api("GET", `/api/v1/locations/${item.id}`);
        const evse = (detail.body.location as LocationDetail).evses?.find(
          (e) =>
            e.status === "AVAILABLE" &&
            (e.capabilities.length === 0 ||
              e.capabilities.includes("REMOTE_START_STOP_CAPABLE")),
        );
        if (evse)
          return {
            appId: item.id,
            evseUid: evse.uid,
            connectorId: evse.connectors[0]?.id,
          };
      }
      throw new Error(
        "No available EVSE that takes remote starts: set OCPI_E2E_LOCATION_ID",
      );
    }

    it("tokens: the driver signs in, and their app token and RFID card are pushed", async (ctx) => {
      const peer = need(ctx, run.peer, "the handshake");
      const email = h.driverEmail;
      const code = await h.api("POST", "/api/v1/auth/code", {
        body: { email },
      });
      expect(code.status).toBe(202);
      const verified = await h.api("POST", "/api/v1/auth/verify", {
        body: { email, code: DEMO_CODE },
      });
      expect(verified.status).toBe(200);
      const session = verified.body.session as { accessToken: string };
      const driver = verified.body.driver as { id: string };
      run.accessToken = session.accessToken;
      run.driverId = driver.id;

      // The first sign-in made the app token and pushed it to every CPO.
      const [app] = await h.stores.tokens.listByDriver(driver.id);
      expect(app.type).toBe("APP_USER");
      run.appToken = app;
      const card = await addRfidCard(
        {
          driverRef: driver.id,
          uid: randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase(),
        },
        {
          tokens: h.stores.tokens,
          peers: h.stores.peers,
          client: h.client,
          actor: "e2e",
        },
      );
      expect(card.pushes).toEqual([
        expect.objectContaining({ peerId: peer.id, ok: true }),
      ]);
      run.rfid = card.token;
      expect(await h.stores.tokens.countPendingPushes(10)).toBe(0);

      const atCpo = await tokenAtCpo(app);
      expect(atCpo).toMatchObject({
        uid: app.uid,
        type: "APP_USER",
        contract_id: app.contractId,
        valid: true,
      });
      // RFID cards cannot charge yet: always NEVER, so the CPO must ask us.
      expect(await tokenAtCpo(card.token)).toMatchObject({
        uid: card.token.uid,
        type: "RFID",
        whitelist: "NEVER",
      });
    });

    it("the driver saves a card (Stripe test mode)", async (ctx) => {
      const driverId = need(ctx, run.driverId, "the sign-in");
      const stripe = stripeApi();
      expect(stripe, "live mode with a Stripe key").not.toBeNull();
      const customer = await stripe!.createCustomer(
        { email: h.driverEmail, driverRef: driverId },
        `emsp-e2e:${driverId}:customer`,
      );
      const card = await h.attachCard(customer.id);
      const now = new Date().toISOString();
      await h.stores.accounts.setCustomer(driverId, customer.id, now);
      await h.stores.accounts.updateDriver(
        driverId,
        { defaultPaymentMethodId: card },
        now,
      );
      run.card = card;
    });

    it(`START_SESSION: the CPO ${scenario === "accepted" ? "accepts it and the session starts" : "rejects it, and the app shows remote start not available"}`, async (ctx) => {
      const location = need(ctx, run.location, "locations");
      need(ctx, run.card, "a saved card");
      h.cpo.answerStarts(scenario);
      const res = await h.api("POST", "/api/v1/charges", {
        token: run.accessToken,
        body: {
          requestId: `e2e-${randomUUID()}`,
          locationId: location.appId,
          evseUid: location.evseUid,
          connectorId: location.connectorId,
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const command = res.body.command as CommandView;
      run.startId = command.id;

      if (scenario === "rejected") {
        expect(
          command.status,
          "the CPO accepted the start: set OCPI_E2E_EXPECT_START=accepted",
        ).toBe("not_supported");
        expect(command.pending).toBe(false);
        expect(command.message).toMatch(REMOTE_START_UNAVAILABLE);
        // What the app polls shows the same state, and no money stays held.
        const polled = await charge(command.id);
        expect(polled.command.status).toBe("not_supported");
        expect(polled.command.message).toMatch(REMOTE_START_UNAVAILABLE);
        expect(polled.payment?.status).toBe("released");
        return;
      }

      expect(
        command.status,
        "the CPO refused the start: some CPOs disable remote start; set OCPI_E2E_EXPECT_START=rejected",
      ).toMatch(/^(accepted|succeeded)$/);
      expect((res.body.payment as { status: string }).status).toBe("held");
      await h.cpo.charge();
      const started = await waitFor(
        h,
        "the CommandResult and the session",
        async () => {
          const c = (await charge(command.id)).command;
          if (c.status !== "accepted" && c.status !== "succeeded")
            throw new Error(`The start ended ${c.status}: ${c.message}`);
          return c.status === "succeeded" && c.sessionId ? c : undefined;
        },
        { tick: pull },
      );
      run.sessionId = started.sessionId!;
    });

    it("session updates: the session is linked to the start and runs", async (ctx) => {
      ctx.skip(
        scenario === "rejected",
        "remote start not available: no session",
      );
      const sessionId = need(ctx, run.sessionId, "the start");
      const [stored] = await h.stores.sessions.findSessions(
        run.peer!.id,
        sessionId,
      );
      expect(stored).toMatchObject({
        commandId: run.startId,
        driverRef: run.driverId,
      });
      expect(stored.session.cdr_token.uid).toBe(run.appToken!.uid);
      const ours = (type: string) =>
        h.sessionEvents.filter(
          (e) =>
            e.type === type && "session" in e && e.session.id === stored.id,
        );
      expect(ours("session.started")).toHaveLength(1);
      // Let the car charge, collecting the CPO's updates (real lane).
      const until = Date.now() + h.chargeMs;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, h.pollMs));
        await pull();
      }
      if (h.lane === "mock") {
        expect(ours("session.updated").length).toBeGreaterThan(0);
        const now = await h.stores.sessions.getSessionById(stored.id);
        expect(now!.session.kwh).toBe(3.2);
      }
    });

    it("STOP_SESSION: the CPO stops the session and completes it", async (ctx) => {
      ctx.skip(
        scenario === "rejected",
        "remote start not available: no session to stop",
      );
      const sessionId = need(ctx, run.sessionId, "the start");
      const res = await h.api("POST", `/api/v1/charges/${run.startId}/stop`, {
        token: run.accessToken,
        body: { requestId: `e2e-${randomUUID()}` },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const stop = res.body.command as CommandView;
      expect(stop.type).toBe("STOP_SESSION");
      expect(stop.status).toMatch(/^(accepted|succeeded)$/);
      await h.cpo.finish(sessionId);
      await waitFor(
        h,
        "the STOP_SESSION CommandResult",
        async () => {
          const c = (await charge(stop.id)).command;
          if (!c.pending && c.status !== "succeeded")
            throw new Error(`The stop ended ${c.status}: ${c.message}`);
          return c.status === "succeeded";
        },
        { tick: pull },
      );
      const done = await waitFor(
        h,
        "the session to end",
        async () => {
          const [s] = await h.stores.sessions.findSessions(
            run.peer!.id,
            sessionId,
          );
          return s?.completedAt ? s : undefined;
        },
        { tick: pull },
      );
      run.sessionCompleted = true;
      // At least one change after the start: live kWh, or the completion itself.
      expect(
        h.sessionEvents.filter(
          (e) =>
            e.type === "session.updated" &&
            "session" in e &&
            e.session.id === done.id,
        ).length,
      ).toBeGreaterThan(0);
    });

    it("CDR: received (or pulled), immutable, linked to the start", async (ctx) => {
      ctx.skip(scenario === "rejected", "remote start not available: no CDR");
      const startId = need(ctx, run.startId, "the start");
      need(ctx, run.sessionCompleted, "the stop");
      const [cdr] = await waitFor(
        h,
        "the CDR",
        async () => {
          const list = await h.stores.sessions.findCdrsByCommand(startId);
          return list.length ? list : undefined;
        },
        { tick: pull },
      );
      expect(cdr).toMatchObject({
        commandId: startId,
        driverRef: run.driverId,
        peerId: run.peer!.id,
      });
      expect(cdr.cdr.session_id).toBe(run.sessionId);
      expect(cdr.cdr.cdr_token.uid).toBe(run.appToken!.uid);
      run.cdrMinor = cdrAmount(cdr.cdr.total_cost, cdr.cdr.currency).minor;
    });

    it("payment: captured from the CDR, never above the hold", async (ctx) => {
      ctx.skip(
        scenario === "rejected",
        "remote start not available: the hold was released (checked at the start)",
      );
      const startId = need(ctx, run.startId, "the start");
      const cdrMinor = need(ctx, run.cdrMinor, "the CDR");
      const payment = await waitFor(h, "the payment to settle", async () => {
        const p = await h.stores.payments.getByCommand(startId);
        return p && ["captured", "released"].includes(p.status) ? p : undefined;
      });
      run.paymentId = payment.id;
      if (cdrMinor === 0) {
        expect(payment.status).toBe("released");
        return;
      }
      expect(payment.status).toBe("captured");
      expect(payment.capturedAmount).toBe(
        Math.min(cdrMinor, payment.authorizedAmount),
      );
      expect(payment.capturedAmount).toBeLessThanOrEqual(
        payment.authorizedAmount,
      );
      run.captured = payment.capturedAmount ?? undefined;
      // Stripe agrees.
      const pi = await stripeApi()!.getPaymentIntent(payment.paymentIntentId!);
      expect(pi.status).toBe("succeeded");
      expect(pi.amount_received).toBe(payment.capturedAmount);
      // And the driver sees it.
      const list = await h.api("GET", "/api/v1/payments", {
        token: run.accessToken,
      });
      expect(list.body.payments).toEqual([
        expect.objectContaining({
          chargeId: startId,
          status: "captured",
          capturedAmount: payment.capturedAmount,
        }),
      ]);
    });

    it("refund: part of the capture goes back to the card", async (ctx) => {
      ctx.skip(
        scenario === "rejected",
        "remote start not available: no capture",
      );
      const paymentId = need(ctx, run.paymentId, "the capture");
      ctx.skip(!run.captured, "the CDR cost nothing: nothing to refund");
      const amount = Math.min(run.captured!, 50);
      const refund = await refundPayment(
        {
          paymentId,
          amount,
          requestId: `e2e-${randomUUID()}`,
          reason: "OCPI e2e test",
        },
        paymentDeps("e2e"),
      );
      expect(refund.amount).toBe(amount);
      expect(refund.status).toMatch(/^(succeeded|pending)$/);
      expect(refund.stripeRefundId).toMatch(/^re_/);
    });

    it("real-time authorization: the app token may charge, an RFID card may not", async (ctx) => {
      const app = need(ctx, run.appToken, "the token push");
      const rfid = need(ctx, run.rfid, "the token push");
      need(ctx, run.card, "a saved card");
      if (h.cpo.authorize) {
        const location = run.location
          ? {
              location_id: h.target.locationId!,
              ...(h.target.evseUid ? { evse_uids: [h.target.evseUid] } : {}),
            }
          : undefined;
        const allowed = await h.cpo.authorize(app.uid, "APP_USER", location);
        expect(allowed.allowed).toBe("ALLOWED");
        expect(allowed.authorization_reference).toBeTruthy();
        expect((await h.cpo.authorize(rfid.uid, "RFID")).allowed).toBe(
          "NOT_ALLOWED",
        );
        return;
      }
      // A real CPO asks on its own (at a start, or a card at the charger): check what
      // it asked during this run.
      const asked = h.stores.peers.auditLog.filter(
        (a) => a.action === "token.authorize",
      );
      ctx.skip(
        asked.length === 0,
        "the CPO did not ask for real-time authorization during this run",
      );
      for (const a of asked) {
        const d = a.details as { allowed: string; type: string };
        if (a.subjectId === rfid.id) expect(d.allowed).toBe("NOT_ALLOWED");
        if (a.subjectId === app.id) expect(d.allowed).toBe("ALLOWED");
      }
    });

    it.skip("UNLOCK_CONNECTOR: this eMSP does not send it yet", () => {});

    it("unregisters at the CPO (credentials DELETE)", async (ctx) => {
      const peer = need(ctx, run.peer, "the handshake");
      ctx.skip(h.keepRegistration, "OCPI_E2E_KEEP_REGISTRATION=1");
      const done = await unregisterPeer(peer.id, {
        store: h.stores.peers,
        client: h.client,
        actor: "e2e",
      });
      expect(done.status).toBe("unregistered");
    });
  });
}
