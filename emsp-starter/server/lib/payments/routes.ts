import "server-only";
import { body, failed, json, withDriver } from "@/lib/accounts/api";
import type { Driver } from "@/lib/accounts/store";
import {
  CommandError,
  getCommand,
  startSession,
  stopSession,
  type CommandDeps,
} from "@/lib/commands/manage";
import { stopCodeOf } from "@/lib/driver-app/charges";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { listCards, removeCard, setDefaultCard, setupCard } from "./cards";
import { commandDepsOf } from "./listen";
import { paymentDeps, type PaymentDeps } from "./registry";
import { PaymentError } from "./settle";
import type { Payment } from "./store";
import { handleEvent, parseEvent, verifySignature } from "./webhook";

/**
 * The driver API's card and charging endpoints (all need the driver's Bearer token):
 *
 *   GET    /api/v1/cards                      the saved cards (brand, last 4, expiry)
 *   POST   /api/v1/cards/setup                { requestId, stripeVersion } -> PaymentSheet setup
 *   PUT    /api/v1/cards/default              { paymentMethodId }
 *   DELETE /api/v1/cards/{id}
 *   POST   /api/v1/charges                    { requestId, locationId, evseUid?, connectorId? }
 *   GET    /api/v1/charges/{id}               poll a start (or stop) and its payment
 *   POST   /api/v1/charges/{id}/stop          { requestId }
 *   GET    /api/v1/payments                   the driver's payments, newest first
 *
 * And Stripe's webhook, `POST /api/webhooks/stripe`.
 */

/** What a driver sees of a payment: amounts in minor units, never card data. */
export function paymentView(p: Payment) {
  return {
    id: p.id,
    chargeId: p.commandId,
    status: p.status,
    currency: p.currency,
    holdAmount: p.holdAmount,
    authorizedAmount: p.authorizedAmount,
    capturedAmount: p.capturedAmount,
    refundedAmount: p.refundedAmount,
    sessionCost: p.cdrAmount,
    stopReason: p.stopReason,
    // The app's own words for why we stopped it (hold_increment_declined, other).
    stopCode: stopCodeOf(p.stopReason),
    underReview: p.review !== null && !p.reviewedAt,
    demo: isDemo(),
    createdAt: p.createdAt,
  };
}

function errorAnswer(request: Request, e: unknown, what: string) {
  if (e instanceof PaymentError || e instanceof CommandError)
    return json(request, { error: e.message }, e.httpStatus);
  return failed(request, what, e);
}

function driverRoute(
  request: Request,
  what: string,
  fn: (driver: Driver, deps: PaymentDeps) => Promise<Response>,
) {
  return withDriver(request, async (driver) => {
    try {
      return await fn(driver, paymentDeps(`driver:${driver.id}`));
    } catch (e) {
      return errorAnswer(request, e, what);
    }
  });
}

export const cardsRoute = (request: Request) =>
  driverRoute(request, "cards", async (driver, deps) =>
    json(request, {
      cards: await listCards(driver, deps),
      mode: isDemo() ? "demo" : "live",
    }),
  );

export const setupRoute = (request: Request) =>
  driverRoute(request, "card setup", async (driver, deps) => {
    const input = await body(request);
    if (!input) return json(request, { error: "Send a JSON object." }, 400);
    return json(request, await setupCard(driver, input, deps));
  });

export const defaultCardRoute = (request: Request) =>
  driverRoute(request, "default card", async (driver, deps) => {
    const input = await body(request);
    if (!input) return json(request, { error: "Send a JSON object." }, 400);
    const done = await setDefaultCard(driver, input.paymentMethodId, deps);
    return json(request, {
      defaultPaymentMethodId: done.defaultPaymentMethodId,
    });
  });

export const removeCardRoute = (request: Request, id: string) =>
  driverRoute(request, "card removal", async (driver, deps) => {
    const done = await removeCard(driver, id, deps);
    return json(request, {
      defaultPaymentMethodId: done.defaultPaymentMethodId,
    });
  });

const optionalString = (v: unknown) => (typeof v === "string" ? v : undefined);

function commandDeps(deps: PaymentDeps, driver: Driver): CommandDeps {
  return { ...commandDepsOf(deps), actor: `driver:${driver.id}` };
}

export const startRoute = (request: Request) =>
  driverRoute(request, "start", async (driver, deps) => {
    const input = await body(request);
    if (!input) return json(request, { error: "Send a JSON object." }, 400);
    const outcome = await startSession(
      {
        driverRef: driver.id,
        requestId: optionalString(input.requestId) ?? "",
        locationId: optionalString(input.locationId) ?? "",
        evseUid: optionalString(input.evseUid),
        connectorId: optionalString(input.connectorId),
      },
      commandDeps(deps, driver),
    );
    const payment = await deps.payments.getByCommand(outcome.command.id);
    return json(
      request,
      { ...outcome, payment: payment && paymentView(payment) },
      outcome.state === "created" ? 201 : 200,
    );
  });

export const chargeRoute = (request: Request, id: string) =>
  driverRoute(request, "charge", async (driver, deps) => {
    const command = await getCommand(id, driver.id, commandDeps(deps, driver));
    if (!command) return json(request, { error: "No such charge." }, 404);
    const payment = await deps.payments.getByCommand(command.id);
    return json(request, { command, payment: payment && paymentView(payment) });
  });

export const stopRoute = (request: Request, id: string) =>
  driverRoute(request, "stop", async (driver, deps) => {
    const input = await body(request);
    if (!input) return json(request, { error: "Send a JSON object." }, 400);
    const start = /^[0-9a-f-]{36}$/i.test(id)
      ? await deps.commands.get(id.toLowerCase())
      : null;
    if (
      !start ||
      start.driverRef !== driver.id ||
      start.type !== "START_SESSION"
    )
      return json(request, { error: "No such charge." }, 404);
    if (!start.sessionId)
      return json(
        request,
        { error: "The session has not started yet. Try again in a moment." },
        409,
      );
    const outcome = await stopSession(
      {
        driverRef: driver.id,
        requestId: optionalString(input.requestId) ?? "",
        peerId: start.peerId,
        sessionId: start.sessionId,
      },
      commandDeps(deps, driver),
    );
    return json(request, outcome, outcome.state === "created" ? 201 : 200);
  });

export const paymentsRoute = (request: Request) =>
  driverRoute(request, "payments", async (driver, deps) =>
    json(request, {
      payments: (await deps.payments.listByDriver(driver.id, 50)).map(
        paymentView,
      ),
    }),
  );

/** Most a webhook body may be. Stripe's events are far smaller. */
const WEBHOOK_MAX_BYTES = 512 * 1024;

/** POST /api/webhooks/stripe: signature checked, each event handled once. */
export async function stripeWebhookRoute(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const secret = config.stripeWebhookSecret;
  if (isDemo() || !secret)
    return Response.json(
      { error: "Webhook not set up" },
      { status: 503, headers },
    );
  if (Number(request.headers.get("content-length") ?? 0) > WEBHOOK_MAX_BYTES)
    return Response.json({ error: "Too large" }, { status: 413, headers });
  const payload = await request.text();
  if (payload.length > WEBHOOK_MAX_BYTES)
    return Response.json({ error: "Too large" }, { status: 413, headers });
  if (
    !verifySignature(payload, request.headers.get("stripe-signature"), secret)
  )
    return Response.json(
      { error: "Invalid signature" },
      { status: 400, headers },
    );
  const event = parseEvent(payload);
  if (!event)
    return Response.json({ error: "Invalid event" }, { status: 400, headers });
  try {
    const outcome = await handleEvent(event, paymentDeps("stripe"));
    return Response.json({ received: true, outcome }, { headers });
  } catch {
    // Logged by handleEvent, by name only. Stripe delivers it again.
    return Response.json(
      { error: "Something went wrong" },
      { status: 500, headers },
    );
  }
}
