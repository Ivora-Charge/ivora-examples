import "server-only";
import { body, failed, json, withDriver } from "@/lib/accounts/api";
import type { Driver } from "@/lib/accounts/store";
import { getCommand } from "@/lib/commands/manage";
import type { Command } from "@/lib/commands/store";
import { holdCurrency } from "@/lib/payments/hold";
import { commandDepsOf } from "@/lib/payments/listen";
import { paymentDeps, type PaymentDeps } from "@/lib/payments/registry";
import { paymentView } from "@/lib/payments/routes";
import { receiptEmail } from "@/lib/receipts/receipt";
import { adapterFor } from "@/lib/live-data/registry";
import { sessionLive } from "@/lib/live-data/live";
import { BodyTooLargeError, readLimitedText } from "@/lib/ocpi/body";
import { parseLocationAppId } from "@/lib/locations/search";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { rateLimit } from "@/lib/server/rate-limit";
import {
  activeCharge,
  cdrOfStart,
  history,
  placeOf,
  receiptView,
  sessionOfStart,
  sessionView,
} from "./charges";
import { advanceDemoCharge } from "./demo-charging";
import { installDriverAppListeners } from "./listen";
import { driverAppStore } from "./registry";
import {
  MAX_FAVOURITES,
  PROBLEM_CATEGORIES,
  type DriverAppStore,
  type PhotoType,
  type ProblemCategory,
} from "./store";

/**
 * The driver API's endpoints for the app's charging, history and support screens (all
 * need the driver's Bearer token; the driver is always the signed-in one, never an ID
 * the app sends):
 *
 *   GET    /api/v1/charges/quote?locationId&evseUid&connectorId   the hold before a start
 *   GET    /api/v1/charges/active                    the charge in progress, or null
 *   GET    /api/v1/charges/{id}/session              its session: kWh, time, cost, SoC
 *   GET    /api/v1/charges/{id}/receipt              the receipt, from the CDR
 *   POST   /api/v1/charges/{id}/receipt/email        email the receipt again
 *   GET    /api/v1/history                           charges with a payment, newest first
 *   PUT    /api/v1/push-token                        { token, platform, locale }
 *   DELETE /api/v1/push-token                        { token }
 *   GET    /api/v1/favourites
 *   PUT    /api/v1/favourites/{locationId}
 *   DELETE /api/v1/favourites/{locationId}
 *   POST   /api/v1/problems                          { locationId, evseUid?, category, message, photo? }
 *
 * Importing this file subscribes payments, push notifications and demo charging to the
 * server's events, like the OCPI receivers do.
 */
installDriverAppListeners();

export type DriverAppDeps = PaymentDeps & { app: DriverAppStore };

function driverRoute(
  request: Request,
  what: string,
  fn: (driver: Driver, deps: DriverAppDeps) => Promise<Response>,
) {
  return withDriver(request, async (driver) => {
    try {
      return await fn(driver, {
        ...paymentDeps(`driver:${driver.id}`),
        app: driverAppStore(),
      });
    } catch (e) {
      return failed(request, what, e);
    }
  });
}

/** One of the driver's starts, or null. */
async function ownStart(
  id: string,
  driver: Driver,
  deps: PaymentDeps,
): Promise<Command | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const c = await deps.commands.get(id.toLowerCase());
  return c && c.driverRef === driver.id && c.type === "START_SESSION"
    ? c
    : null;
}

const notFound = (request: Request) =>
  json(request, { error: "No such charge." }, 404);

const ID = /^[A-Za-z0-9_-]{1,36}$/;

export const quoteRoute = (request: Request) =>
  driverRoute(request, "quote", async (driver, deps) => {
    const q = new URL(request.url).searchParams;
    const key = parseLocationAppId(q.get("locationId") ?? "");
    const evseUid = q.get("evseUid") || null;
    const connectorId = q.get("connectorId") || null;
    if (
      !key ||
      (evseUid && !ID.test(evseUid)) ||
      (connectorId && !ID.test(connectorId))
    )
      return json(request, { error: "Unknown location." }, 404);
    if (!(await deps.locations.getLocation(key))?.location.publish)
      return json(request, { error: "Unknown location." }, 404);
    const currency = await holdCurrency(
      {
        peerId: key.peerId,
        toCountryCode: key.countryCode,
        toPartyId: key.partyId,
        locationId: key.id,
        evseUid,
        connectorId,
      } as Command,
      deps,
    );
    const amount = config.holdAmounts[currency] ?? null;
    return json(request, {
      currency,
      holdAmount: amount,
      // The hold may be raised during a long session, where the card allows it.
      mayRaise: config.incrementalAuth.enabled || isDemo(),
      demo: isDemo(),
      hasCard: driver.defaultPaymentMethodId !== null,
    });
  });

export const activeRoute = (request: Request) =>
  driverRoute(request, "active charge", async (driver, deps) => {
    const c = await activeCharge(driver.id, deps);
    if (!c) return json(request, { charge: null });
    await advanceDemoCharge(c, deps);
    const command = await getCommand(c.id, driver.id, commandDepsOf(deps));
    const payment = await deps.payments.getByCommand(c.id);
    return json(request, {
      charge: command && {
        command,
        payment: payment && paymentView(payment),
        place: await placeOf(c, deps.locations),
      },
    });
  });

export const sessionRoute = (request: Request, id: string) =>
  driverRoute(request, "session", async (driver, deps) => {
    let c = await ownStart(id, driver, deps);
    if (!c) return notFound(request);
    await advanceDemoCharge(c, deps);
    c = (await deps.commands.get(c.id)) ?? c;
    const s = await sessionOfStart(c, deps.sessions);
    const live = s
      ? await sessionLive(s.id, driver.id, {
          sessions: deps.sessions,
          adapterFor: (peerId) => adapterFor(peerId),
        })
      : null;
    const payment = await deps.payments.getByCommand(c.id);
    return json(request, {
      session: s && sessionView(s),
      live: live?.live ?? {},
      liveSource: live?.source ?? null,
      payment: payment && paymentView(payment),
      place: await placeOf(c, deps.locations),
    });
  });

export const historyRoute = (request: Request) =>
  driverRoute(request, "history", async (driver, deps) =>
    json(request, { items: await history(driver.id, deps), demo: isDemo() }),
  );

export const receiptRoute = (request: Request, id: string) =>
  driverRoute(request, "receipt", async (driver, deps) => {
    const c = await ownStart(id, driver, deps);
    if (!c) return notFound(request);
    const [p, cdr] = await Promise.all([
      deps.payments.getByCommand(c.id),
      cdrOfStart(c, deps.sessions),
    ]);
    if (!p || !cdr || p.cdrId === null)
      return json(
        request,
        {
          error:
            "The receipt is not ready yet: it comes when the operator sends the final bill.",
        },
        409,
      );
    return json(request, { receipt: receiptView(c, p, cdr.cdr, cdr.id) });
  });

/** At most 3 copies of receipts per driver per hour, per server instance. */
const receiptCopies = rateLimit({ limit: 3, windowMs: 60 * 60_000 });

export const emailReceiptRoute = (request: Request, id: string) =>
  driverRoute(request, "receipt email", async (driver, deps) => {
    const c = await ownStart(id, driver, deps);
    if (!c) return notFound(request);
    const [p, cdr] = await Promise.all([
      deps.payments.getByCommand(c.id),
      cdrOfStart(c, deps.sessions),
    ]);
    if (!p || !cdr || p.cdrId === null)
      return json(request, { error: "The receipt is not ready yet." }, 409);
    if (!deps.mailer)
      return json(
        request,
        { error: "Email receipts are not set up on this network." },
        503,
      );
    const wait = receiptCopies.check(driver.id);
    if (wait !== null)
      return json(
        request,
        { error: "Too many receipts sent. Try again later." },
        429,
        { "Retry-After": String(wait) },
      );
    const email = receiptEmail(driver.email, p, cdr.cdr, { demo: isDemo() });
    // A copy on request: its own key, so the provider does not drop it as a repeat.
    await deps.mailer.send({
      ...email,
      idempotencyKey: `${email.idempotencyKey}:copy:${Date.now()}`,
    });
    return json(request, { sent: !isDemo(), demo: isDemo() }, 202);
  });

const PUSH_TOKEN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{8,200}\]$/;
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;
/** At most 20 push token saves per driver per hour, per server instance. */
const pushSaves = rateLimit({ limit: 20, windowMs: 60 * 60_000 });

export const putPushTokenRoute = (request: Request) =>
  driverRoute(request, "push token", async (driver, deps) => {
    const input = await body(request);
    if (!input) return json(request, { error: "Send a JSON object." }, 400);
    const { token, platform, locale } = input;
    if (typeof token !== "string" || !PUSH_TOKEN.test(token))
      return json(request, { error: "Send an Expo push token." }, 400);
    if (platform !== "ios" && platform !== "android")
      return json(request, { error: "Platform must be ios or android." }, 400);
    const wait = pushSaves.check(driver.id);
    if (wait !== null)
      return json(request, { error: "Too many requests." }, 429, {
        "Retry-After": String(wait),
      });
    const lang =
      typeof locale === "string" && LOCALE.test(locale) && locale.length <= 35
        ? locale
        : "en";
    await deps.app.putPushToken(
      { token, driverRef: driver.id, platform, locale: lang },
      new Date().toISOString(),
    );
    // Demo mode keeps it in memory and never sends a notification.
    return json(request, { saved: true, demo: isDemo() });
  });

export const deletePushTokenRoute = (request: Request) =>
  driverRoute(request, "push token", async (driver, deps) => {
    const input = await body(request);
    if (!input || typeof input.token !== "string")
      return json(request, { error: "Send the push token." }, 400);
    await deps.app.removePushToken(driver.id, input.token);
    return json(request, { removed: true });
  });

export const favouritesRoute = (request: Request) =>
  driverRoute(request, "favourites", async (driver, deps) => {
    const places = new Map();
    const favourites = [];
    for (const f of await deps.app.listFavourites(driver.id)) {
      const key = parseLocationAppId(f.locationId);
      const place = key
        ? await placeOf(
            {
              peerId: key.peerId,
              toCountryCode: key.countryCode,
              toPartyId: key.partyId,
              locationId: key.id,
            } as Command,
            deps.locations,
            places,
          )
        : null;
      // A location its CPO no longer lists stays a favourite, without its details.
      favourites.push({
        locationId: f.locationId,
        createdAt: f.createdAt,
        place,
      });
    }
    return json(request, { favourites });
  });

export const putFavouriteRoute = (request: Request, locationId: string) =>
  driverRoute(request, "favourite", async (driver, deps) => {
    const key = parseLocationAppId(locationId);
    if (!key || !(await deps.locations.getLocation(key))?.location.publish)
      return json(request, { error: "Unknown location." }, 404);
    const mine = await deps.app.listFavourites(driver.id);
    if (
      mine.length >= MAX_FAVOURITES &&
      !mine.some((f) => f.locationId === locationId)
    )
      return json(
        request,
        { error: `At most ${MAX_FAVOURITES} favourites. Remove one first.` },
        409,
      );
    await deps.app.addFavourite(
      driver.id,
      locationId,
      new Date().toISOString(),
    );
    return json(request, { favourite: true });
  });

export const deleteFavouriteRoute = (request: Request, locationId: string) =>
  driverRoute(request, "favourite", async (driver, deps) => {
    await deps.app.removeFavourite(driver.id, locationId);
    return json(request, { favourite: false });
  });

/** A report's body may carry a photo: at most this many bytes of JSON. */
export const PROBLEM_BODY_MAX = 1_500_000;
/** The photo itself, decoded. */
export const PHOTO_MAX_BYTES = 1_000_000;
/** Reports per driver per day. */
export const REPORTS_PER_DAY = 10;

/** A JPEG or PNG, by its first bytes: never what the app says it is. */
export function photoType(bytes: Buffer): PhotoType | null {
  if (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length > 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  return null;
}

/** A JSON object of at most `max` bytes: the stream is cut off past it, with or without a Content-Length. */
export async function largeBody(
  request: Request,
  max: number,
): Promise<Record<string, unknown> | null | "too_large"> {
  let text: string;
  try {
    text = await readLimitedText(request, max);
  } catch (e) {
    return e instanceof BodyTooLargeError ? "too_large" : null;
  }
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const problemRoute = (request: Request) =>
  driverRoute(request, "problem report", async (driver, deps) => {
    const input = await largeBody(request, PROBLEM_BODY_MAX);
    if (input === "too_large")
      return json(
        request,
        { error: "The photo is too large (1 MB at most)." },
        413,
      );
    if (!input) return json(request, { error: "Send a JSON object." }, 400);
    const locationId =
      typeof input.locationId === "string" ? input.locationId : "";
    const key = parseLocationAppId(locationId);
    if (!key || !(await deps.locations.getLocation(key)))
      return json(request, { error: "Unknown location." }, 404);
    const evseUid =
      typeof input.evseUid === "string" && input.evseUid ? input.evseUid : null;
    if (evseUid && !ID.test(evseUid))
      return json(request, { error: "Unknown charger." }, 400);
    const category = input.category;
    if (!(PROBLEM_CATEGORIES as readonly unknown[]).includes(category))
      return json(request, { error: "Choose what went wrong." }, 400);
    const message =
      typeof input.message === "string"
        ? input.message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim()
        : "";
    if (message.length < 1 || message.length > 2000)
      return json(
        request,
        { error: "Describe the problem in 1 to 2,000 characters." },
        400,
      );
    let photo: { type: PhotoType; base64: string } | null = null;
    if (input.photo !== undefined && input.photo !== null) {
      const data = typeof input.photo === "string" ? input.photo : "";
      const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(data)
        ? Buffer.from(data, "base64")
        : Buffer.alloc(0);
      const type = photoType(bytes);
      if (!type)
        return json(
          request,
          { error: "The photo must be a JPEG or PNG." },
          400,
        );
      if (bytes.length > PHOTO_MAX_BYTES)
        return json(
          request,
          { error: "The photo is too large (1 MB at most)." },
          413,
        );
      photo = { type, base64: bytes.toString("base64") };
    }
    const now = new Date();
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    if ((await deps.app.countReportsSince(driver.id, since)) >= REPORTS_PER_DAY)
      return json(
        request,
        { error: "You've sent many reports today. Try again tomorrow." },
        429,
        { "Retry-After": "3600" },
      );
    const report = await deps.app.addReport(
      {
        driverRef: driver.id,
        locationId,
        evseUid,
        category: category as ProblemCategory,
        message,
        photoType: photo?.type ?? null,
        photoBase64: photo?.base64 ?? null,
      },
      now.toISOString(),
    );
    return json(request, { id: report.id, demo: isDemo() }, 201);
  });
