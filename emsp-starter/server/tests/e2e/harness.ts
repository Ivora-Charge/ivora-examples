import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { vi } from "vitest";
import * as codeRoute from "@/app/api/v1/auth/code/route";
import * as verifyRoute from "@/app/api/v1/auth/verify/route";
import * as chargesRoute from "@/app/api/v1/charges/route";
import * as chargeRoute from "@/app/api/v1/charges/[id]/route";
import * as stopRoute from "@/app/api/v1/charges/[id]/stop/route";
import * as locationsRoute from "@/app/api/v1/locations/route";
import * as locationRoute from "@/app/api/v1/locations/[id]/route";
import * as paymentsRoute from "@/app/api/v1/payments/route";
import { clearUserCacheForTests } from "@/lib/accounts/api";
import { DemoAuth } from "@/lib/accounts/auth";
import {
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import { resetSignInLimitsForTests } from "@/lib/accounts/sign-in";
import { MemoryAccountStore } from "@/lib/accounts/store";
import { setPreAuthForTests } from "@/lib/commands/pre-auth";
import { setCommandStoreForTests } from "@/lib/commands/registry";
import { MemoryCommandStore } from "@/lib/commands/store";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { MemoryLocationStore } from "@/lib/locations/store";
import { createMockCpo } from "@/lib/mock-cpo";
import type { ClientOptions, Transport } from "@/lib/ocpi/client";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import type {
  AuthorizationInfo,
  LocationReferences,
  TokenType,
} from "@/lib/ocpi/token-objects";
import { ocpiTimestamp } from "@/lib/ocpi/types";
import { installPaymentListeners } from "@/lib/payments/listen";
import {
  setPaymentStoreForTests,
  setStripeForTests,
} from "@/lib/payments/registry";
import { MemoryPaymentStore } from "@/lib/payments/store";
import { stripeClient } from "@/lib/payments/stripe";
import { DemoOutbox, setMailerForTests } from "@/lib/receipts/mailer";
import { outboundFetch } from "@/lib/server/demo";
import { onSessionEvent, type SessionEvent } from "@/lib/sessions/events";
import { setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { createMockStripe } from "../support/mock-stripe";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "../support/network";
import type { ExpectStart, Lane } from "./lanes";

/**
 * What the suite needs from the CPO side, the one thing that differs between lanes.
 * The mock CPO plays the charger when asked; a real CPO does all of it on its own, so
 * there these are no-ops and the suite waits for the CPO's pushes (or pulls them).
 */
export type CpoSide = {
  label: string;
  versionsUrl: string;
  tokenA(): string;
  /** The mock answers START_SESSION as the scenario says. A real CPO decides itself. */
  answerStarts(expect: ExpectStart): void;
  /** After a start is accepted: the CommandResult, the session, a live update. */
  charge(): Promise<void>;
  /** After a stop is accepted: the CommandResult, the completed session, the CDR. */
  finish(sessionId: string): Promise<void>;
  /** The CPO asks for real-time authorization. Absent: only what it asked on its own. */
  authorize?: (
    uid: string,
    type: TokenType,
    location?: LocationReferences,
  ) => Promise<AuthorizationInfo>;
};

/** A request the CPO made to our OCPI endpoints: method, path and status, no headers. */
export type Inbound = { method: string; path: string; status: number };

export type Stores = {
  peers: MemoryPeerStore;
  tokens: MemoryTokenStore;
  locations: MemoryLocationStore;
  commands: MemoryCommandStore;
  sessions: MemorySessionStore;
  accounts: MemoryAccountStore;
  payments: MemoryPaymentStore;
};

export type Harness = {
  lane: Lane["kind"];
  scenario: ExpectStart;
  cpo: CpoSide;
  stores: Stores;
  /** OCPI client options for the eMSP's own calls to the CPO. */
  client: ClientOptions | undefined;
  /** How long to wait for an answer or push of the CPO, and to let a car charge. */
  waitMs: number;
  chargeMs: number;
  /** Between two looks while waiting. */
  pollMs: number;
  driverEmail: string;
  /** Where to start: the CPO's own location ID, EVSE uid and connector ID. */
  target: { locationId?: string; evseUid?: string; connectorId?: string };
  keepRegistration: boolean;
  sessionEvents: SessionEvent[];
  /** Requests the CPO made to us (real lane; the mock lane talks in-process). */
  inbound: Inbound[];
  /** A request to the eMSP's own OCPI endpoints, the way a CPO reaches them. */
  fetchOurs(path: string, init?: RequestInit): Promise<Response>;
  /** The driver API, as the app calls it. */
  api(
    method: "GET" | "POST",
    path: string,
    options?: { body?: unknown; token?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** A card that authorises, saved on the Stripe Customer: its PaymentMethod ID. */
  attachCard(customer: string): Promise<string>;
  close(): Promise<void>;
};

/** A fixed, fake key for the mock lane's mock Stripe. */
const MOCK_STRIPE_KEY = "sk_test_e2emock0123456789";

const DRIVER_ROUTES: [RegExp, Record<string, unknown>][] = [
  [/^\/api\/v1\/auth\/code$/, codeRoute],
  [/^\/api\/v1\/auth\/verify$/, verifyRoute],
  [/^\/api\/v1\/locations$/, locationsRoute],
  [/^\/api\/v1\/locations\/([^/]+)$/, locationRoute],
  [/^\/api\/v1\/charges$/, chargesRoute],
  [/^\/api\/v1\/charges\/([^/]+)\/stop$/, stopRoute],
  [/^\/api\/v1\/charges\/([^/]+)$/, chargeRoute],
  [/^\/api\/v1\/payments$/, paymentsRoute],
];

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response> | Response;

/** Calls a driver API route as Next.js would dispatch it. */
async function callDriverApi(
  method: "GET" | "POST",
  path: string,
  { body, token }: { body?: unknown; token?: string } = {},
) {
  const url = new URL(path, process.env.PUBLIC_BASE_URL);
  const found = DRIVER_ROUTES.map(
    ([re, mod]) => [re.exec(url.pathname), mod] as const,
  ).find(([m]) => m);
  const handler = found?.[1][method] as RouteHandler | undefined;
  if (!found || !handler) throw new Error(`No route for ${method} ${path}`);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handler(
    new Request(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: found[0]![1] ?? "" }) },
  );
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

function memoryStores(): Stores {
  const peers = new MemoryPeerStore();
  const stores = {
    peers,
    tokens: new MemoryTokenStore(peers),
    locations: new MemoryLocationStore(),
    commands: new MemoryCommandStore(),
    sessions: new MemorySessionStore(),
    accounts: new MemoryAccountStore(),
    payments: new MemoryPaymentStore(),
  };
  setPeerStoreForTests(stores.peers);
  setTokenStoreForTests(stores.tokens);
  setLocationStoreForTests(stores.locations);
  setCommandStoreForTests(stores.commands);
  setSessionStoreForTests(stores.sessions);
  setAccountStoreForTests(stores.accounts);
  setPaymentStoreForTests(stores.payments);
  return stores;
}

function resetOverrides() {
  setPeerStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setCommandStoreForTests(undefined);
  setSessionStoreForTests(undefined);
  setAccountStoreForTests(undefined);
  setPaymentStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setMailerForTests(undefined);
  setStripeForTests(undefined);
  setPreAuthForTests(undefined);
}

/** Variables that would make the run send email or reach another service. */
const UNSET = [
  "DEMO_MODE",
  "RESEND_API_KEY",
  "RECEIPT_FROM",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_INCREMENTAL_AUTH",
  "SUPABASE_DB_URL",
];

/**
 * The eMSP for one scenario: live mode, every store in memory (the run needs no
 * database), sign-in without email (DemoAuth), and no receipts sent. The lane decides
 * the CPO, Stripe and the network.
 */
export async function createHarness(
  lane: Lane,
  scenario: ExpectStart,
): Promise<Harness> {
  const saved = { ...process.env };
  for (const k of UNSET) delete process.env[k];
  const stores = memoryStores();
  setAuthProviderForTests(new DemoAuth());
  setMailerForTests(new DemoOutbox());
  setPreAuthForTests(undefined);
  clearUserCacheForTests();
  resetSignInLimitsForTests();

  const sessionEvents: SessionEvent[] = [];
  const unsubscribe = onSessionEvent((e) => {
    sessionEvents.push(e);
  });
  const inbound: Inbound[] = [];
  let teardown: () => Promise<void>;
  let cpo: CpoSide;
  let fetchOurs: Harness["fetchOurs"];
  let attachCard: Harness["attachCard"];
  let settings: Omit<
    Harness,
    | "cpo"
    | "stores"
    | "sessionEvents"
    | "inbound"
    | "fetchOurs"
    | "api"
    | "attachCard"
    | "close"
  >;

  if (lane.kind === "mock") {
    Object.assign(process.env, LIVE_ENV, {
      STRIPE_SECRET_KEY: MOCK_STRIPE_KEY,
    });
    const stripe = createMockStripe();
    const mock = createMockCpo({
      // Set below: the network needs the mock, and the mock the network.
      transport: (url, init) => transport(url, init),
      name: "Mock CPO",
    });
    const net = inProcessNetwork({
      [new URL(LIVE_ENV.PUBLIC_BASE_URL).host]: emspHandler,
      [new URL(mock.urls.versions).host]: (r) => mock.handle(r),
      "api.stripe.com": (r) => stripe.handle(r),
    });
    const transport: Transport = net.transport;
    installNetwork(transport);
    setStripeForTests(stripeClient(MOCK_STRIPE_KEY, { retryDelayMs: 0 }));
    // The mock's clock: each push is a minute after the last, so none looks stale.
    let minute = -30;
    const nextAt = () => new Date(Date.now() + ++minute * 60_000);
    cpo = {
      label: "Mock CPO",
      versionsUrl: mock.urls.versions,
      tokenA: () => mock.issueTokenA(),
      answerStarts: (expect) =>
        mock.answerCommands(
          expect === "accepted"
            ? { result: "ACCEPTED", timeout: 30 }
            : { result: "REJECTED", timeout: 0 },
        ),
      async charge() {
        await mock.sendCommandResult("ACCEPTED");
        const session = mock.sessionForCommand({
          id: `E2E-${randomUUID().slice(0, 8)}`,
          at: nextAt(),
        });
        await mock.putSession(session, { push: true });
        await mock.patchSession(
          session.id,
          { kwh: 3.2 },
          { push: true, at: nextAt() },
        );
      },
      async finish(sessionId) {
        await mock.sendCommandResult("ACCEPTED");
        const at = nextAt();
        await mock.patchSession(
          sessionId,
          { kwh: 7.5, status: "COMPLETED", end_date_time: ocpiTimestamp(at) },
          { push: true, at },
        );
        const cdr = mock.cdrFor(sessionId, {
          totalCost: { excl_vat: 10, incl_vat: 12.1 },
        });
        await mock.postCdr(cdr, { push: true });
      },
      authorize: (uid, type, location) =>
        mock.authorize(uid, { type, location }),
    };
    fetchOurs = (path, init = {}) =>
      transport(`${LIVE_ENV.PUBLIC_BASE_URL}${path}`, init);
    attachCard = async (customer) => stripe.attachCard(customer, "visa");
    settings = {
      lane: "mock",
      scenario,
      client: { retries: 0, timeoutMs: 2_000 },
      waitMs: 5_000,
      chargeMs: 0,
      pollMs: 10,
      driverEmail: "e2e-driver@example.com",
      target: { locationId: "LOC1", evseUid: "LOC1-1", connectorId: "1" },
      keepRegistration: false,
    };
    teardown = async () => uninstallNetwork();
  } else {
    const s = lane.settings;
    Object.assign(process.env, {
      PUBLIC_BASE_URL: s.publicUrl,
      // Every store is in memory: these only satisfy live mode, and are never called.
      SUPABASE_URL: "https://supabase.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "e2e-memory-stores-only",
      // A new key per run: the peer's token lives only as long as the run.
      OCPI_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });
    const server = await listen(s.listenPort, s.publicUrl, inbound);
    cpo = {
      label: "OCPI e2e CPO",
      versionsUrl: s.versionsUrl,
      tokenA: () => s.tokenA,
      answerStarts: () => undefined,
      charge: async () => undefined,
      finish: async () => undefined,
    };
    fetchOurs = (path, init) => outboundFetch(`${s.publicUrl}${path}`, init);
    attachCard = (customer) => attachTestCard(customer);
    settings = {
      lane: "real",
      scenario,
      client: undefined,
      waitMs: s.waitMs,
      chargeMs: s.chargeMs,
      pollMs: 2_000,
      driverEmail: s.driverEmail,
      target: s.target,
      keepRegistration: s.keepRegistration,
    };
    teardown = () =>
      new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // The routes install these on import; this makes sure, and does nothing twice.
  installPaymentListeners();

  return {
    ...settings,
    cpo,
    stores,
    sessionEvents,
    inbound,
    fetchOurs,
    api: callDriverApi,
    attachCard,
    async close() {
      unsubscribe();
      await teardown();
      resetOverrides();
      clearUserCacheForTests();
      process.env = saved;
      vi.restoreAllMocks();
    },
  };
}

/** Waits until `check` gives a value, looking every `pollMs`, then fails naming `what`. */
export async function waitFor<T>(
  h: Pick<Harness, "waitMs" | "pollMs">,
  what: string,
  check: () => Promise<T | null | undefined | false>,
  {
    timeoutMs = h.waitMs,
    tick,
  }: { timeoutMs?: number; tick?: () => Promise<void> } = {},
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() >= until)
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`,
      );
    await new Promise((r) => setTimeout(r, h.pollMs));
    await tick?.();
  }
}

/** Hop-by-hop headers, and ones the Request sets itself. */
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/**
 * The real lane's OCPI server: our OCPI routes on 127.0.0.1, for a tunnel or proxy
 * that gives them the public `publicUrl`. Records method, path and status of each
 * request, never headers or bodies (they carry tokens).
 */
export async function listen(
  port: number,
  publicUrl: string,
  inbound: Inbound[],
): Promise<Server> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", publicUrl);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (!SKIP_HEADERS.has(k) && v !== undefined)
        for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
    if (size) headers.set("content-length", String(size));
    let response: Response;
    try {
      response = await emspHandler(
        new Request(url, {
          method,
          headers,
          body:
            method === "GET" || method === "HEAD"
              ? undefined
              : Buffer.concat(chunks),
        }),
      );
    } catch (e) {
      console.error(
        `OCPI e2e server: ${method} ${url.pathname} failed: ${e instanceof Error ? e.name : "unknown error"}`,
      );
      response = new Response("Internal error", { status: 500 });
    }
    inbound.push({ method, path: url.pathname, status: response.status });
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

/**
 * Stripe test mode only: saves Stripe's test card `pm_card_visa` on the Customer, as
 * the app's PaymentSheet would. lanes.ts refuses any key that is not a test key.
 */
async function attachTestCard(customer: string): Promise<string> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(key))
    throw new Error(
      "Refusing to save a card with a key that is not a test key",
    );
  const res = await outboundFetch(
    "https://api.stripe.com/v1/payment_methods/pm_card_visa/attach",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `emsp-e2e:${customer}:card`,
      },
      body: new URLSearchParams({ customer }).toString(),
    },
  );
  const json = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (!res.ok || typeof json.id !== "string")
    throw new Error(`Saving the test card failed: HTTP ${res.status}`);
  return json.id;
}
