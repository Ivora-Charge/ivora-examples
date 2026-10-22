import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { setAccountStoreForTests } from "@/lib/accounts/registry";
import { MemoryAccountStore } from "@/lib/accounts/store";
import { startSession, type CommandDeps } from "@/lib/commands/manage";
import { setPreAuthForTests } from "@/lib/commands/pre-auth";
import { setCommandStoreForTests } from "@/lib/commands/registry";
import { MemoryCommandStore, type Command } from "@/lib/commands/store";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { locationAppId } from "@/lib/locations/search";
import { MemoryLocationStore } from "@/lib/locations/store";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import type { ClientOptions } from "@/lib/ocpi/client";
import { connectToCpo } from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import type { Session } from "@/lib/ocpi/session-objects";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import { onPaymentEvent, type PaymentEvent } from "@/lib/payments/events";
import {
  holdCurrency,
  placeHold,
  UNCERTAIN_KEEP_MS,
} from "@/lib/payments/hold";
import { installPaymentListeners } from "@/lib/payments/listen";
import { cdrAmount, toMinor } from "@/lib/payments/money";
import {
  paymentDeps,
  setPaymentStoreForTests,
  setStripeForTests,
  type PaymentDeps,
} from "@/lib/payments/registry";
import {
  captureForReview,
  INCREMENT_DECLINED_REASON,
  PaymentError,
  refundPayment,
  releaseForReview,
  settleCdr,
  sweepPayments,
} from "@/lib/payments/settle";
import { MemoryPaymentStore, type Payment } from "@/lib/payments/store";
import { stripeClient } from "@/lib/payments/stripe";
import { handleEvent, verifySignature } from "@/lib/payments/webhook";
import { POST as webhookPOST } from "@/app/api/webhooks/stripe/route";
import { DemoOutbox, setMailerForTests } from "@/lib/receipts/mailer";
import { setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { createAppToken } from "@/lib/tokens/manage";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { createMockStripe, type MockStripe } from "./support/mock-stripe";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const T0 = new Date("2026-10-21T10:00:00Z");
const DRIVER = "driver-1";
const KEY = "sk_test_mock0123456789";
const WHSEC = "whsec_mocksecret0123456789";
const client: ClientOptions = { retries: 0, timeoutMs: 500 };

let peers: MemoryPeerStore;
let tokens: MemoryTokenStore;
let locations: MemoryLocationStore;
let commands: MemoryCommandStore;
let sessions: MemorySessionStore;
let accounts: MemoryAccountStore;
let payments: MemoryPaymentStore;
let outbox: DemoOutbox;
let stripe: MockStripe;
let cpo: MockCpo;
let one: Peer;
let card: string;
let events: PaymentEvent[];
let unsubscribe: () => void;
const saved = { ...process.env };

const commandDeps = (over: Partial<CommandDeps> = {}): CommandDeps => ({
  commands,
  peers,
  tokens,
  locations,
  client,
  now: () => T0,
  ...over,
});

const deps = (over: Partial<PaymentDeps> = {}): PaymentDeps => ({
  ...paymentDeps("test"),
  ...over,
});

beforeEach(async () => {
  Object.assign(process.env, LIVE_ENV, { STRIPE_SECRET_KEY: KEY });
  for (const k of [
    "DEMO_MODE",
    "HOLD_AMOUNTS",
    "STRIPE_INCREMENTAL_AUTH",
    "HOLD_INCREMENT_AT_PERCENT",
    "STRIPE_WEBHOOK_SECRET",
  ])
    delete process.env[k];
  peers = new MemoryPeerStore();
  tokens = new MemoryTokenStore(peers);
  locations = new MemoryLocationStore();
  commands = new MemoryCommandStore();
  sessions = new MemorySessionStore();
  accounts = new MemoryAccountStore();
  payments = new MemoryPaymentStore();
  outbox = new DemoOutbox();
  setPeerStoreForTests(peers);
  setTokenStoreForTests(tokens);
  setLocationStoreForTests(locations);
  setCommandStoreForTests(commands);
  setSessionStoreForTests(sessions);
  setAccountStoreForTests(accounts);
  setPaymentStoreForTests(payments);
  setMailerForTests(outbox);
  setPreAuthForTests(undefined);
  stripe = createMockStripe();
  const net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": (r) => cpo.handle(r),
    "api.stripe.com": (r) => stripe.handle(r),
  });
  cpo = createMockCpo({ transport: net.transport });
  installNetwork(net.transport);
  // The server's own Stripe client, over HTTP to the mock, without the retry delay.
  setStripeForTests(stripeClient(KEY, { retryDelayMs: 0 }));
  installPaymentListeners();
  vi.spyOn(console, "error").mockImplementation(() => {});
  events = [];
  unsubscribe = onPaymentEvent((e) => {
    events.push(e);
  });

  one = await connectToCpo(
    {
      label: "Mock CPO",
      versionsUrl: cpo.urls.versions,
      tokenA: cpo.issueTokenA(),
    },
    { store: peers, client },
  );
  await locations.saveTariffs(one.id, cpo.state.tariffs, T0.toISOString());
  await locations.saveLocations(one.id, cpo.state.locations, T0.toISOString());
  for (const driverRef of [DRIVER, "driver-2"])
    await createAppToken(
      { driverRef },
      { tokens, peers, client, actor: "test" },
    );

  // DRIVER signed up, with a Stripe Customer and a saved default card.
  const now = new Date().toISOString();
  await accounts.ensureDriver(DRIVER, "driver1@example.com", now);
  const customer = stripe.customer("driver1@example.com");
  await accounts.setCustomer(DRIVER, customer, now);
  card = stripe.attachCard(customer, "visa");
  await accounts.updateDriver(DRIVER, { defaultPaymentMethodId: card }, now);
});

afterEach(() => {
  unsubscribe();
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setCommandStoreForTests(undefined);
  setSessionStoreForTests(undefined);
  setAccountStoreForTests(undefined);
  setPaymentStoreForTests(undefined);
  setMailerForTests(undefined);
  setStripeForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

let seq = 0;
const newRequestId = () => `req-${String(++seq).padStart(6, "0")}`;
const LOC1 = () =>
  locationAppId({
    peerId: one.id,
    countryCode: "ZZ",
    partyId: "MCK",
    id: "LOC1",
  });

/** The driver taps start at LOC1-1. */
const tapStart = (driverRef = DRIVER) =>
  startSession(
    {
      driverRef,
      requestId: newRequestId(),
      locationId: LOC1(),
      evseUid: "LOC1-1",
      connectorId: "1",
    },
    commandDeps(),
  );

/** A start the charger accepted, with its session pushed to us. */
async function charging(
  id = "SESSION-1",
): Promise<{ command: Command; session: Session; payment: Payment }> {
  const { command } = await tapStart();
  expect(command.status).toBe("accepted");
  await cpo.sendCommandResult("ACCEPTED");
  const session = cpo.sessionForCommand({ id, at: T0 });
  await cpo.putSession(session, { push: true });
  return {
    command: (await commands.get(command.id))!,
    session,
    payment: (await payments.getByCommand(command.id))!,
  };
}

/** The CPO ends the session and POSTs its CDR. */
async function cdr(
  sessionId: string,
  totalCost: { excl_vat: number; incl_vat?: number },
  over: { currency?: string } = {},
) {
  const c = cpo.cdrFor(sessionId, { totalCost, ...over });
  await cpo.postCdr(c, { push: true });
  return c;
}

const paymentOf = async (commandId: string) =>
  (await payments.getByCommand(commandId))!;

describe("money", () => {
  it("rounds a CDR amount to minor units once, half up", () => {
    expect(toMinor(12.345, "EUR")).toBe(1235);
    expect(toMinor(12.3449, "EUR")).toBe(1234);
    expect(toMinor(0.005, "EUR")).toBe(1);
    expect(toMinor(1234.5, "JPY")).toBe(1235);
    expect(toMinor(10, "EUR")).toBe(1000);
    expect(cdrAmount({ excl_vat: 10, incl_vat: 12.1 }, "EUR")).toEqual({
      minor: 1210,
      vatKnown: true,
    });
    expect(cdrAmount({ excl_vat: 10 }, "EUR")).toEqual({
      minor: 1000,
      vatKnown: false,
    });
  });
});

describe("the hold before START_SESSION", () => {
  it("holds the card with a manual-capture PaymentIntent, then sends the start", async () => {
    const { command } = await tapStart();
    const holds = stripe.callsTo(/^\/v1\/payment_intents$/);
    expect(holds).toHaveLength(1);
    const p = holds[0].params;
    expect(holds[0].key).toBe(`emsp:${command.id}:hold`);
    expect(holds[0].version).toBe("2025-09-30.clover");
    expect(
      Object.fromEntries(
        [
          "amount",
          "currency",
          "capture_method",
          "confirm",
          "off_session",
          "payment_method",
        ].map((k) => [k, p.get(k)]),
      ),
    ).toEqual({
      amount: "2500",
      currency: "eur",
      capture_method: "manual",
      confirm: "true",
      off_session: "true",
      payment_method: card,
    });
    // Incremental authorization is off by default: not even asked for.
    expect(
      p.get("payment_method_options[card][request_incremental_authorization]"),
    ).toBeNull();
    const payment = await paymentOf(command.id);
    expect(payment).toMatchObject({
      status: "held",
      currency: "EUR",
      holdAmount: 2500,
      authorizedAmount: 2500,
      incrementalAvailable: false,
    });
    expect(payment.paymentIntentId).toMatch(/^pi_/);
    expect(Date.parse(payment.holdExpiresAt!)).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );
    expect((await commands.get(command.id))!.holdRef).toBe(payment.id);
    expect(cpo.state.commands).toHaveLength(1);
    // The audit names the payment and the command, never the driver or the card.
    const log = JSON.stringify(
      peers.auditLog.filter((a) => a.action.startsWith("payment.")),
    );
    expect(log).toContain(command.id);
    expect(log).not.toContain(DRIVER);
    expect(log).not.toContain(card);
  });

  it("takes the amount from HOLD_AMOUNTS for the charger's tariff currency", async () => {
    process.env.HOLD_AMOUNTS = "EUR:4000,GBP:3000";
    const { command } = await tapStart();
    expect((await paymentOf(command.id)).holdAmount).toBe(4000);

    // A charger billing in a currency without an amount takes no app starts.
    const tariff = cpo.state.tariffs.find((t) =>
      cpo.state.locations[0].evses![0].connectors[0].tariff_ids?.includes(t.id),
    )!;
    await locations.saveTariffs(
      one.id,
      [{ ...tariff, currency: "CHF", last_updated: "2026-10-21T11:00:00Z" }],
      T0.toISOString(),
    );
    const c = { ...(await commands.get(command.id))! };
    expect(await holdCurrency(c, { locations })).toBe("CHF");
  });

  it("refuses the start, sending nothing, without an account, a card or Stripe", async () => {
    const refused = async (driverRef: string, reason: string) => {
      const { command } = await tapStart(driverRef);
      expect(command).toMatchObject({ status: "hold_failed", message: reason });
    };
    await refused("driver-2", "Sign in to the app to charge.");
    const now = new Date().toISOString();
    await accounts.ensureDriver("driver-2", "d2@example.com", now);
    await refused(
      "driver-2",
      "Add a payment card in the app before you charge.",
    );
    await accounts.updateDriver(DRIVER, { status: "restricted" }, now);
    await refused(DRIVER, "This account may not charge. Contact support.");
    await accounts.updateDriver(DRIVER, { status: "active" }, now);
    setStripeForTests(null);
    await refused(DRIVER, "Payments are not set up on this network yet.");
    expect(cpo.state.commands).toHaveLength(0);
    expect(stripe.state.calls).toHaveLength(0);
  });

  it("fails the hold of a declined card with words for the driver, and sends nothing", async () => {
    const customer = (await accounts.getDriver(DRIVER))!.stripeCustomerId!;
    for (const [behaviour, words] of [
      ["declined", "Your card was declined. Choose another card in the app."],
      [
        "insufficient",
        "Your card was declined (insufficient funds). Choose another card in the app.",
      ],
      [
        "sca",
        "Your bank wants to confirm this card. Add it again in the app, or choose another card.",
      ],
    ]) {
      const pm = stripe.attachCard(customer, behaviour);
      await accounts.updateDriver(
        DRIVER,
        { defaultPaymentMethodId: pm },
        new Date().toISOString(),
      );
      const { command } = await tapStart();
      expect(command).toMatchObject({ status: "hold_failed", message: words });
      expect((await paymentOf(command.id)).status).toBe("failed");
    }
    expect(cpo.state.commands).toHaveLength(0);
  });

  it("retries an unanswered hold once with the same key, then flags it and sends nothing", async () => {
    stripe.state.failures.push({
      path: /^\/v1\/payment_intents$/,
      kind: "network",
      times: 2,
    });
    const { command } = await tapStart();
    expect(command.status).toBe("hold_failed");
    const calls = stripe.callsTo(/^\/v1\/payment_intents$/);
    expect(calls.map((c) => c.key)).toEqual([
      `emsp:${command.id}:hold`,
      `emsp:${command.id}:hold`,
    ]);
    expect(await paymentOf(command.id)).toMatchObject({
      status: "failed",
      review: "hold_unknown",
    });
    expect(cpo.state.commands).toHaveLength(0);
  });

  it("gets the first answer back when only the answer was lost: one hold, not two", async () => {
    stripe.state.failures.push({
      path: /^\/v1\/payment_intents$/,
      kind: "network",
      times: 1,
      after: true,
    });
    const { command } = await tapStart();
    expect(command.status).toBe("accepted");
    expect(stripe.state.intents.size).toBe(1);
    expect((await paymentOf(command.id)).status).toBe("held");
  });
});

describe("capture from the CDR", () => {
  it("captures the CDR total incl. VAT, rounded once, and emails one receipt", async () => {
    const { command, payment } = await charging();
    await cdr("SESSION-1", { excl_vat: 10.2, incl_vat: 12.345 });
    const captures = stripe.callsTo(/\/capture$/);
    expect(captures).toHaveLength(1);
    expect(captures[0].key).toBe(`emsp:${command.id}:capture`);
    expect(captures[0].params.get("amount_to_capture")).toBe("1235");
    expect(await paymentOf(command.id)).toMatchObject({
      status: "captured",
      capturedAmount: 1235,
      cdrAmount: 1235,
      cdrCurrency: "EUR",
      review: null,
    });
    expect(stripe.intent(payment.paymentIntentId!)!.amount_received).toBe(1235);
    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]).toMatchObject({
      to: "driver1@example.com",
      idempotencyKey: `receipt:${payment.id}`,
    });
    expect(outbox.sent[0].text).toContain("€12.35");
    expect(outbox.sent[0].text).not.toContain(card);
    expect(events.map((e) => e.type)).toEqual(["payment.captured"]);

    // The same CDR again (a retry) and the sweep change nothing.
    await cdr("SESSION-1", { excl_vat: 10.2, incl_vat: 12.345 });
    await sweepPayments(deps());
    expect(stripe.callsTo(/\/capture$/)).toHaveLength(1);
    expect(outbox.sent).toHaveLength(1);
  });

  it("captures the hold and flags the rest for review when the CDR is above it", async () => {
    const { command } = await charging();
    await cdr("SESSION-1", { excl_vat: 33.06, incl_vat: 40 });
    expect(
      stripe.callsTo(/\/capture$/)[0].params.get("amount_to_capture"),
    ).toBe("2500");
    expect(await paymentOf(command.id)).toMatchObject({
      status: "captured",
      capturedAmount: 2500,
      cdrAmount: 4000,
      review: "cdr_above_hold",
      shortfallAmount: 1500,
    });
    expect(events.map((e) => e.type)).toEqual([
      "payment.captured",
      "payment.review",
    ]);
    expect(outbox.sent[0].text).toContain("not charged automatically");
  });

  it("releases the hold of a zero-cost session", async () => {
    const { command, payment } = await charging();
    await cdr("SESSION-1", { excl_vat: 0, incl_vat: 0 });
    expect(stripe.callsTo(/\/capture$/)).toHaveLength(0);
    expect(stripe.callsTo(/\/cancel$/).map((c) => c.key)).toEqual([
      `emsp:${command.id}:cancel`,
    ]);
    expect(await paymentOf(command.id)).toMatchObject({
      status: "released",
      cdrAmount: 0,
    });
    expect(stripe.intent(payment.paymentIntentId!)!.status).toBe("canceled");
    expect(outbox.sent[0].text).toContain("Nothing was charged");
  });

  it("charges nothing for a CDR in another currency, until an admin decides", async () => {
    const { command, payment } = await charging();
    await cdr("SESSION-1", { excl_vat: 10, incl_vat: 12 }, { currency: "GBP" });
    expect(stripe.callsTo(/\/capture$/)).toHaveLength(0);
    expect(await paymentOf(command.id)).toMatchObject({
      status: "held",
      review: "currency_mismatch",
      cdrCurrency: "GBP",
      releaseAfter: null,
    });
    // The sweep leaves it to a person.
    await sweepPayments(deps());
    expect(stripe.callsTo(/\/capture$/)).toHaveLength(0);
    await expect(
      captureForReview({ paymentId: payment.id, amount: 2501 }, deps()),
    ).rejects.toThrow("at most the hold");
    const done = await captureForReview(
      { paymentId: payment.id, amount: 1400 },
      deps(),
    );
    expect(done).toMatchObject({ status: "captured", capturedAmount: 1400 });
    expect(done.reviewedAt).not.toBeNull();
  });

  it("flags a late CDR after the hold expired and charges nothing", async () => {
    const { command, payment } = await charging();
    await payments.transition(
      payment.id,
      ["held"],
      { holdExpiresAt: "2026-10-20T00:00:00.000Z" },
      T0.toISOString(),
    );
    await cdr("SESSION-1", { excl_vat: 10, incl_vat: 12 });
    expect(stripe.callsTo(/\/capture$/)).toHaveLength(0);
    expect(await paymentOf(command.id)).toMatchObject({
      status: "expired",
      review: "hold_expired",
      shortfallAmount: 1200,
      capturedAmount: 0,
    });
  });

  it("flags a CDR whose hold the card network already dropped", async () => {
    const { command, payment } = await charging();
    stripe.expire(payment.paymentIntentId!);
    await cdr("SESSION-1", { excl_vat: 10, incl_vat: 12 });
    expect(await paymentOf(command.id)).toMatchObject({
      status: "expired",
      review: "hold_expired",
      capturedAmount: 0,
    });
  });

  it("captures the amount excl. VAT and flags it when the CDR gives no VAT", async () => {
    const { command } = await charging();
    await cdr("SESSION-1", { excl_vat: 10 });
    expect(await paymentOf(command.id)).toMatchObject({
      status: "captured",
      capturedAmount: 1000,
      review: "vat_unknown",
    });
  });

  it("captures only from a CDR of its own start's session", async () => {
    const { command, session } = await charging();
    // Another session carries the same authorization_reference: its CDR is the
    // driver's by token, never the start's.
    await cpo.putSession({ ...session, id: "SESSION-2" });
    await cdr("SESSION-2", { excl_vat: 10, incl_vat: 12 });
    expect(stripe.callsTo(/\/capture$/)).toHaveLength(0);
    expect((await paymentOf(command.id)).status).toBe("held");
    // A credit CDR for the start goes to a person.
    const credit = cpo.cdrFor("SESSION-1", {
      totalCost: { excl_vat: -5, incl_vat: -6 },
    });
    expect(
      await settleCdr(
        {
          cdr: {
            ...credit,
            id: "CREDIT-1",
            credit: true,
            credit_reference_id: "CDR-SESSION-1",
          },
          id: crypto.randomUUID(),
          peerId: one.id,
          driverRef: DRIVER,
          commandId: command.id,
          source: "push",
          receivedAt: T0.toISOString(),
        },
        deps(),
      ),
    ).toMatchObject({ status: "held", review: "credit_cdr" });
  });
});

describe("release", () => {
  it("releases the hold at once when the charger refuses the start", async () => {
    cpo.answerCommands({ result: "REJECTED", timeout: 30 });
    const { command } = await tapStart();
    expect(command.status).toBe("not_supported");
    expect(stripe.callsTo(/\/cancel$/).map((c) => c.key)).toEqual([
      `emsp:${command.id}:cancel`,
    ]);
    expect(await paymentOf(command.id)).toMatchObject({
      status: "released",
      releaseAfter: null,
    });
  });

  it("keeps the hold of a start with no answer, then releases it if no session came", async () => {
    const { command } = await tapStart();
    await cpo.sendCommandResult("TIMEOUT");
    expect((await commands.get(command.id))!.status).toBe("timed_out");
    const kept = await paymentOf(command.id);
    expect(kept.status).toBe("held");
    expect(Date.parse(kept.releaseAfter!)).toBeGreaterThan(
      Date.now() + UNCERTAIN_KEEP_MS - 60_000,
    );
    expect(stripe.callsTo(/\/cancel$/)).toHaveLength(0);

    const later = new Date(Date.now() + UNCERTAIN_KEEP_MS + 60_000);
    expect(await sweepPayments(deps({ now: () => later }))).toEqual({
      settled: 0,
      released: 1,
      expired: 0,
    });
    expect((await paymentOf(command.id)).status).toBe("released");
  });

  it("keeps the hold of a start with no answer when its session appears, and charges its CDR", async () => {
    const { command } = await tapStart();
    await cpo.sendCommandResult("TIMEOUT");
    await cpo.putSession(cpo.sessionForCommand({ id: "SESSION-9", at: T0 }), {
      push: true,
    });
    const later = new Date(Date.now() + UNCERTAIN_KEEP_MS + 60_000);
    await sweepPayments(deps({ now: () => later }));
    expect(await paymentOf(command.id)).toMatchObject({
      status: "held",
      releaseAfter: null,
    });
    await cdr("SESSION-9", { excl_vat: 5, incl_vat: 6 });
    expect(await paymentOf(command.id)).toMatchObject({
      status: "captured",
      capturedAmount: 600,
    });
  });

  it("sweeps a CDR the event missed, and retries a capture whose answer was lost", async () => {
    const { command } = await charging();
    stripe.state.failures.push({
      path: /\/capture$/,
      kind: "network",
      times: 2,
      after: true,
    });
    await cdr("SESSION-1", { excl_vat: 10, incl_vat: 12 });
    // Stripe captured, but both answers were lost: still held here.
    expect((await paymentOf(command.id)).status).toBe("held");
    expect(await sweepPayments(deps())).toEqual({
      settled: 1,
      released: 0,
      expired: 0,
    });
    expect(await paymentOf(command.id)).toMatchObject({
      status: "captured",
      capturedAmount: 1200,
    });
    const keys = new Set(stripe.callsTo(/\/capture$/).map((c) => c.key));
    expect([...keys]).toEqual([`emsp:${command.id}:capture`]);
    expect(
      stripe.intent((await paymentOf(command.id)).paymentIntentId!)!
        .amount_received,
    ).toBe(1200);
  });

  it("marks a hold past its expiry with no CDR as expired", async () => {
    const { payment } = await charging();
    const later = new Date(Date.parse(payment.holdExpiresAt!) + 1000);
    expect(await sweepPayments(deps({ now: () => later }))).toEqual({
      settled: 0,
      released: 0,
      expired: 1,
    });
    expect((await payments.get(payment.id))!.status).toBe("expired");
  });
});

describe("refunds", () => {
  it("refunds part of a payment, never more than was captured, and never twice", async () => {
    const { command, payment } = await charging();
    await cdr("SESSION-1", { excl_vat: 10, incl_vat: 12 });
    const first = await refundPayment(
      {
        paymentId: payment.id,
        amount: 500,
        requestId: "refund-0001",
        reason: "Slow charger",
      },
      deps(),
    );
    expect(first).toMatchObject({ status: "succeeded", amount: 500 });
    expect(stripe.callsTo(/^\/v1\/refunds$/)[0].key).toBe(
      `emsp:${command.id}:refund:refund-0001`,
    );
    // The same request again: no second refund.
    expect(
      await refundPayment(
        { paymentId: payment.id, amount: 500, requestId: "refund-0001" },
        deps(),
      ),
    ).toMatchObject({ id: first.id });
    expect(stripe.callsTo(/^\/v1\/refunds$/)).toHaveLength(1);
    await expect(
      refundPayment(
        { paymentId: payment.id, amount: 701, requestId: "refund-0002" },
        deps(),
      ),
    ).rejects.toThrow("more than what is left");
    await refundPayment(
      { paymentId: payment.id, amount: 700, requestId: "refund-0003" },
      deps(),
    );
    expect((await payments.get(payment.id))!.refundedAmount).toBe(1200);
    await expect(
      refundPayment(
        { paymentId: payment.id, amount: 1, requestId: "refund-0004" },
        deps(),
      ),
    ).rejects.toBeInstanceOf(PaymentError);
  });

  it("retries a refund whose answer was lost with the same key: refunded once", async () => {
    const { payment } = await charging();
    await cdr("SESSION-1", { excl_vat: 10, incl_vat: 12 });
    stripe.state.failures.push({
      path: /^\/v1\/refunds$/,
      kind: "network",
      times: 2,
      after: true,
    });
    await expect(
      refundPayment(
        { paymentId: payment.id, amount: 300, requestId: "refund-0101" },
        deps(),
      ),
    ).rejects.toThrow("Stripe did not answer");
    expect((await payments.get(payment.id))!.refundedAmount).toBe(0);
    expect(
      await refundPayment(
        { paymentId: payment.id, amount: 300, requestId: "refund-0101" },
        deps(),
      ),
    ).toMatchObject({ status: "succeeded" });
    expect(stripe.intent(payment.paymentIntentId!)!.refunded).toBe(300);
    expect((await payments.get(payment.id))!.refundedAmount).toBe(300);
  });

  it("refuses a refund of a payment that was not captured", async () => {
    const { payment } = await charging();
    await expect(
      refundPayment(
        { paymentId: payment.id, amount: 1, requestId: "refund-0201" },
        deps(),
      ),
    ).rejects.toThrow("Only a captured payment");
    // An admin may release a held payment instead.
    expect((await releaseForReview(payment.id, deps())).status).toBe(
      "released",
    );
  });
});

describe("incremental authorization", () => {
  const cost = (incl: number) => ({
    total_cost: { excl_vat: incl / 1.2, incl_vat: incl },
    kwh: incl * 2,
  });

  it("is off by default: a long session never raises the hold", async () => {
    const { command } = await charging();
    await cpo.patchSession("SESSION-1", cost(24), {
      push: true,
      at: new Date(T0.getTime() + 60_000),
    });
    expect(stripe.callsTo(/increment_authorization/)).toHaveLength(0);
    expect((await paymentOf(command.id)).authorizedAmount).toBe(2500);
  });

  it("raises the hold before the running cost reaches it, then captures up to the new hold", async () => {
    process.env.STRIPE_INCREMENTAL_AUTH = "on";
    const { command, payment } = await charging();
    expect(
      stripe
        .callsTo(/^\/v1\/payment_intents$/)[0]
        .params.get(
          "payment_method_options[card][request_incremental_authorization]",
        ),
    ).toBe("if_available");
    expect(payment.incrementalAvailable).toBe(true);
    // 19.99 is below 80% of 25.00: nothing yet.
    await cpo.patchSession("SESSION-1", cost(19.99), {
      push: true,
      at: new Date(T0.getTime() + 60_000),
    });
    expect(stripe.callsTo(/increment_authorization/)).toHaveLength(0);
    await cpo.patchSession("SESSION-1", cost(20), {
      push: true,
      at: new Date(T0.getTime() + 120_000),
    });
    const raises = stripe.callsTo(/increment_authorization/);
    expect(raises.map((c) => [c.key, c.params.get("amount")])).toEqual([
      [`emsp:${command.id}:increment:1`, "5000"],
    ]);
    expect(await paymentOf(command.id)).toMatchObject({
      authorizedAmount: 5000,
      increments: 1,
    });
    await cdr("SESSION-1", { excl_vat: 37.5, incl_vat: 45 });
    expect(await paymentOf(command.id)).toMatchObject({
      status: "captured",
      capturedAmount: 4500,
      review: null,
    });
  });

  it("stops the session, stores why and tells the app when a raise is declined", async () => {
    process.env.STRIPE_INCREMENTAL_AUTH = "on";
    stripe.state.declineIncrements = true;
    const { command, payment } = await charging();
    await cpo.patchSession("SESSION-1", cost(21), {
      push: true,
      at: new Date(T0.getTime() + 60_000),
    });
    const stop = cpo.state.commands.at(-1)!;
    expect(stop.type).toBe("STOP_SESSION");
    expect(stop.body).toMatchObject({ session_id: "SESSION-1" });
    const held = await sessions.getSession({
      peerId: one.id,
      countryCode: "ZZ",
      partyId: "MCK",
      sessionId: "SESSION-1",
    });
    expect(held!.stopReason).toBe(INCREMENT_DECLINED_REASON);
    expect(await paymentOf(command.id)).toMatchObject({
      status: "held",
      authorizedAmount: 2500,
      review: "increment_declined",
      stopReason: INCREMENT_DECLINED_REASON,
      incrementalAvailable: false,
    });
    expect(events).toContainEqual({
      type: "hold_increment_declined",
      paymentId: payment.id,
      commandId: command.id,
      driverRef: DRIVER,
      sessionId: "SESSION-1",
      authorizedAmount: 2500,
      currency: "EUR",
      stopReason: INCREMENT_DECLINED_REASON,
    });
    // Another update stops nothing more, and the CDR never captures beyond the hold.
    await cpo.patchSession("SESSION-1", cost(23), {
      push: true,
      at: new Date(T0.getTime() + 120_000),
    });
    expect(
      cpo.state.commands.filter((c) => c.type === "STOP_SESSION"),
    ).toHaveLength(1);
    await cdr("SESSION-1", { excl_vat: 20, incl_vat: 24 });
    expect(await paymentOf(command.id)).toMatchObject({
      status: "captured",
      capturedAmount: 2400,
      review: "increment_declined",
    });
    expect(outbox.sent[0].text).toContain(INCREMENT_DECLINED_REASON);
  });

  it("never raises the hold of a card without incremental authorization", async () => {
    process.env.STRIPE_INCREMENTAL_AUTH = "on";
    const customer = (await accounts.getDriver(DRIVER))!.stripeCustomerId!;
    const pm = stripe.attachCard(customer, "noincrement");
    await accounts.updateDriver(
      DRIVER,
      { defaultPaymentMethodId: pm },
      new Date().toISOString(),
    );
    const { command } = await charging();
    await cpo.patchSession("SESSION-1", cost(24), {
      push: true,
      at: new Date(T0.getTime() + 60_000),
    });
    expect(stripe.callsTo(/increment_authorization/)).toHaveLength(0);
    expect(
      cpo.state.commands.filter((c) => c.type === "STOP_SESSION"),
    ).toHaveLength(0);
    expect((await paymentOf(command.id)).review).toBeNull();
  });
});

describe("the Stripe webhook", () => {
  const sign = (
    payload: string,
    secret = WHSEC,
    t = Math.floor(Date.now() / 1000),
  ) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  const event = (
    type: string,
    object: Record<string, unknown>,
    id = `evt_${crypto.randomUUID().replace(/-/g, "")}`,
  ) => JSON.stringify({ id, type, data: { object } });
  const post = (payload: string, signature: string | null) =>
    webhookPOST(
      new Request("https://emsp.example.test/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: signature ? { "Stripe-Signature": signature } : {},
      }),
    );

  it("checks every request's signature, and is off without STRIPE_WEBHOOK_SECRET", async () => {
    const payload = event("customer.created", { object: "customer" });
    expect((await post(payload, sign(payload))).status).toBe(503);
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    expect((await post(payload, sign(payload))).status).toBe(200);
    expect((await post(payload, sign(payload, "whsec_wrong"))).status).toBe(
      400,
    );
    expect(
      (
        await post(
          payload,
          sign(payload, WHSEC, Math.floor(Date.now() / 1000) - 600),
        )
      ).status,
    ).toBe(400);
    expect((await post(payload, null)).status).toBe(400);
    expect((await post(`${payload} `, sign(payload))).status).toBe(400);
    expect(
      verifySignature(payload, `${sign(payload)},v1=${"0".repeat(64)}`, WHSEC),
    ).toBe(true);
  });

  it("handles each event once, and cancels a hold it never heard back about", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    stripe.state.failures.push({
      path: /^\/v1\/payment_intents$/,
      kind: "network",
      times: 2,
      after: true,
    });
    const { command } = await tapStart();
    const p = await paymentOf(command.id);
    expect(p).toMatchObject({ status: "failed", review: "hold_unknown" });
    // Stripe placed the hold all the same, and reports it.
    const pi = [...stripe.state.intents.values()][0];
    const payload = event("payment_intent.amount_capturable_updated", {
      ...pi,
      latest_charge: null,
    });
    expect(await (await post(payload, sign(payload))).json()).toEqual({
      received: true,
      outcome: "handled",
    });
    expect(stripe.intent(pi.id)!.status).toBe("canceled");
    expect(stripe.callsTo(/\/cancel$/).map((c) => c.key)).toEqual([
      `emsp:${command.id}:cancel-orphan`,
    ]);
    expect((await paymentOf(command.id)).reviewedAt).not.toBeNull();
    expect(await (await post(payload, sign(payload))).json()).toEqual({
      received: true,
      outcome: "duplicate",
    });
    expect(stripe.callsTo(/\/cancel$/)).toHaveLength(1);
  });

  it("follows holds dropped on Stripe's side, disputes, outside refunds and new cards", async () => {
    const { payment } = await charging();
    stripe.expire(payment.paymentIntentId!);
    const d = deps();
    const pi = stripe.intent(payment.paymentIntentId!)!;
    await handleEvent(
      JSON.parse(
        event("payment_intent.canceled", { ...pi, object: "payment_intent" }),
      ),
      d,
    );
    expect((await payments.get(payment.id))!.status).toBe("expired");

    await handleEvent(
      JSON.parse(
        event("charge.dispute.created", {
          object: "dispute",
          payment_intent: pi.id,
        }),
      ),
      d,
    );
    expect((await payments.get(payment.id))!.review).toBe("dispute");

    const now = new Date().toISOString();
    await accounts.updateDriver(DRIVER, { defaultPaymentMethodId: null }, now);
    const customer = (await accounts.getDriver(DRIVER))!.stripeCustomerId;
    await handleEvent(
      JSON.parse(
        event("setup_intent.succeeded", {
          object: "setup_intent",
          customer,
          payment_method: "pm_new123",
        }),
      ),
      d,
    );
    expect((await accounts.getDriver(DRIVER))!.defaultPaymentMethodId).toBe(
      "pm_new123",
    );
  });

  it("flags money refunded outside this server", async () => {
    const { payment } = await charging();
    await cdr("SESSION-1", { excl_vat: 10, incl_vat: 12 });
    await refundPayment(
      { paymentId: payment.id, amount: 200, requestId: "refund-0301" },
      deps(),
    );
    const charge = (n: number) =>
      JSON.parse(
        event("charge.refunded", {
          object: "charge",
          id: "ch_1",
          payment_intent: payment.paymentIntentId,
          amount_refunded: n,
        }),
      );
    await handleEvent(charge(200), deps());
    expect((await payments.get(payment.id))!.review).toBeNull();
    await handleEvent(charge(500), deps());
    expect((await payments.get(payment.id))!.review).toBe("refund_outside");
  });
});

describe("demo mode", () => {
  it("holds, settles and makes a receipt without any request leaving the server", async () => {
    uninstallNetwork();
    const fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    for (const reset of [
      setAccountStoreForTests,
      setPaymentStoreForTests,
      setCommandStoreForTests,
      setSessionStoreForTests,
      setMailerForTests,
    ])
      reset(undefined);
    process.env.DEMO_MODE = "true";
    // Even with a key and a client installed, demo mode gets no Stripe client.
    expect(paymentDeps().stripe).toBeNull();
    const d = paymentDeps("test");
    const command = {
      id: crypto.randomUUID(),
      driverRef: "demo-driver",
      peerId: "demo-mock-cpo",
      toCountryCode: "ZZ",
      toPartyId: "MCK",
      locationId: "LOC1",
      evseUid: null,
      connectorId: null,
    } as Command;
    expect(await placeHold(command, d)).toMatchObject({ ok: true });
    const held = (await d.payments.getByCommand(command.id))!;
    expect(held).toMatchObject({
      status: "held",
      authorizedAmount: 2500,
      paymentIntentId: null,
    });
    // The demo's sample CDR, as if it billed this start.
    const sample = [...(d.sessions as MemorySessionStore).cdrs.values()][0];
    const settled = await settleCdr({ ...sample, commandId: command.id }, d);
    expect(settled).toMatchObject({ status: "captured", capturedAmount: 2321 });
    expect(
      await refundPayment(
        { paymentId: held.id, amount: 100, requestId: "refund-demo-1" },
        d,
      ),
    ).toMatchObject({ status: "succeeded" });
    expect((await d.payments.get(held.id))!.refundedAmount).toBe(100);
    expect(d.mailer!.name).toBe("demo");
    expect((d.mailer as DemoOutbox).sent.at(-1)!.text).toContain(
      "Demo mode: this receipt was not sent",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
