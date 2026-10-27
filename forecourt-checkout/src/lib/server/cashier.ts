import "server-only";
import { cookies } from "next/headers";
import {
  decodeDemoStore,
  demoAuthorize,
  demoConsole,
  demoCounter,
  demoDueEvents,
  demoGiveChange,
  demoMarkPaid,
  demoPrepayQuote,
  demoSaleById,
  demoSales,
  demoStop,
  demoUnplug,
  DEMO_STORE_COOKIE,
  encodeDemoStore,
  type DemoStore,
} from "../demo-store";
import { DEMO_SITE_NAME } from "../demo";
import {
  POS_EVENT_HEADER,
  POS_SIGNATURE_HEADER,
  sessionDueBody,
  signPosBody,
  verifyPosSignature,
  type PosStatus,
} from "../pos";
import { isEmailAddress, receiptEmail } from "../receipt-email";
import type { Settings } from "../settings";
import type { DriverSale, PaymentMethod, SaleTerms, SaleView } from "../store";
import { driverSale, SaleError } from "../store";
import { deliverReceipt, type EmailResult } from "./mailer";
import { posMarkPaid, posSales, type MarkPaidInput } from "./pos";
import {
  DEMO_POS_API_SECRET,
  DEMO_POS_WEBHOOK_SECRET,
  liveStoreDeps,
  receiptMailer,
} from "./services";
import { UserError } from "./sessions";
import {
  authorizeSale,
  consoleState,
  counterState,
  giveChange,
  isClosedSession,
  markSalePaid,
  prepayQuote,
  recentSales,
  saleById,
  stopSale,
  type ConsoleState,
  type CounterState,
  type SimulatedPos,
} from "./store";

// One entry point per cashier action. Demo mode answers from
// src/lib/demo-store.ts with state in the visitor's own cookie, and never
// builds the live dependencies, so it cannot reach Ivora.

const DEMO_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/** Read the demo forecourt; a first visit is seeded and saved (route handlers only). */
async function loadDemo(now: number, save: boolean) {
  const jar = await cookies();
  const { store, fresh } = decodeDemoStore(
    jar.get(DEMO_STORE_COOKIE)?.value,
    now,
  );
  if (fresh && save) await saveDemo(store);
  return store;
}

async function saveDemo(store: DemoStore) {
  (await cookies()).set(DEMO_STORE_COOKIE, encodeDemoStore(store), {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // demo data only
    path: "/",
    maxAge: DEMO_COOKIE_MAX_AGE,
  });
}

async function demoAction(
  now: number,
  act: (store: DemoStore) => { store: DemoStore; view: SaleView },
) {
  const result = act(await loadDemo(now, false));
  await saveDemo(result.store);
  return result.view;
}

/** `known`: sale IDs the console has shown, looked up directly if this instance hasn't indexed them. */
export async function cashierConsole(
  settings: Settings,
  known: string[] = [],
  now = Date.now(),
): Promise<ConsoleState> {
  if (settings.demo) {
    const store = await loadDemo(now, true);
    return {
      ...demoConsole(store, now, settings),
      truncated: false,
      pos: simulatedPos(store, now, settings),
    };
  }
  return consoleState(liveStoreDeps(settings), known);
}

/**
 * The demo's simulated POS: the session_due webhooks the live app would send
 * now, signed and checked exactly as a POS would. Nothing is sent anywhere.
 */
function simulatedPos(
  store: DemoStore,
  now: number,
  settings: Settings,
): SimulatedPos {
  const t = Math.floor(now / 1000);
  return {
    url: "https://pos.example.com/forecourt/webhook",
    apiSecret: DEMO_POS_API_SECRET,
    deliveries: demoDueEvents(store, now, settings).map((event) => {
      const body = sessionDueBody(event);
      const signature = signPosBody(DEMO_POS_WEBHOOK_SECRET, body, t);
      return {
        eventId: event.id,
        signature: `${POS_SIGNATURE_HEADER}: ${signature}`,
        verified:
          verifyPosSignature(DEMO_POS_WEBHOOK_SECRET, signature, body, now) ===
          "ok",
        body: JSON.stringify(JSON.parse(body), null, 2),
        sale: event.sale,
        label: event.charger.label,
        amountDueCents: event.amountDueCents,
        changeDueCents: event.changeDueCents,
        currency: event.currency,
        header: `${POS_EVENT_HEADER}: ${event.id}`,
      };
    }),
  };
}

/** The public driver screen's state: only what the driver needs. */
export type DriverCounter = Omit<CounterState, "sale"> & {
  sale: DriverSale | null;
};

const toDriver = (c: CounterState): DriverCounter => ({
  ...c,
  sale: c.sale && driverSale(c.sale),
});

/** One answer per charger is reused this long, so a public page can't drive Ivora calls. */
export const COUNTER_CACHE_MS = 5000;
const counterCache = new Map<
  string,
  { at: number; state: Promise<DriverCounter> }
>();

export async function counter(
  code: string,
  connector: number,
  settings: Settings,
  now = Date.now(),
): Promise<DriverCounter> {
  if (settings.demo)
    return toDriver(
      demoCounter(await loadDemo(now, true), code, connector, now, settings),
    );
  const key = `${code}/${connector}`;
  const hit = counterCache.get(key);
  if (hit && now - hit.at < COUNTER_CACHE_MS) return hit.state;
  const state = counterState(code, connector, liveStoreDeps(settings)).then(
    toDriver,
  );
  counterCache.set(key, { at: now, state });
  state.catch(() => counterCache.delete(key));
  if (counterCache.size > 500)
    counterCache.delete(counterCache.keys().next().value!);
  return state;
}

export async function authorize(
  input: {
    code: string;
    connector: number;
    terms: SaleTerms;
    requestId: string;
    currency?: string;
  },
  settings: Settings,
  now = Date.now(),
) {
  if (settings.demo)
    return demoAction(now, (store) =>
      demoAuthorize(store, input, now, settings),
    );
  return authorizeSale(input, liveStoreDeps(settings));
}

export type SaleAction =
  | { action: "stop" }
  | { action: "unplug" }
  | { action: "change" }
  | {
      action: "paid";
      amountCents: number;
      method: PaymentMethod;
      posReference: string | null;
    };

export async function saleAction(
  sale: string,
  input: SaleAction,
  settings: Settings,
  now = Date.now(),
): Promise<SaleView> {
  if (settings.demo)
    return demoAction(now, (store) => {
      switch (input.action) {
        case "stop":
          return demoStop(store, sale, now, settings);
        case "unplug":
          return demoUnplug(store, sale, now, settings);
        case "change":
          return demoGiveChange(store, sale, now, settings);
        case "paid":
          return demoMarkPaid(store, { sale, ...input }, now, settings);
      }
    });
  const deps = liveStoreDeps(settings);
  switch (input.action) {
    case "stop":
      return stopSale(sale, deps);
    case "unplug":
      throw new SaleError(
        400,
        "demo_only",
        "Unplugging is detected from the charger in live mode.",
      );
    case "change":
      return giveChange(sale, deps);
    case "paid":
      return markSalePaid({ sale, ...input }, deps);
  }
}

export async function quoteEnergy(
  input: { code: string; connector: number; energyWh: number },
  settings: Settings,
) {
  if (settings.demo) return demoPrepayQuote(input.energyWh, settings);
  return prepayQuote(input, liveStoreDeps(settings));
}

/** For the printable receipt. Read-only in demo mode (server components can't set cookies). */
export async function sale(id: string, settings: Settings, now = Date.now()) {
  if (settings.demo)
    return demoSaleById(await loadDemo(now, false), id, now, settings);
  return saleById(id, liveStoreDeps(settings));
}

/** POST /api/pos/mark-paid: the same markSalePaid() as the console, idempotent by sale ID. */
export function posPay(
  input: MarkPaidInput,
  settings: Settings,
  now = Date.now(),
) {
  return posMarkPaid(input, (i) =>
    saleAction(i.sale, { action: "paid", ...i }, settings, now),
  );
}

/** Most sales GET /api/pos/sessions reads per call. */
export const POS_LIST_LIMIT = 50;

/** GET /api/pos/sessions: recent in-store sales with this status, newest first. */
export async function posList(
  status: PosStatus,
  limit: number,
  settings: Settings,
  now = Date.now(),
) {
  if (settings.demo)
    return posSales(
      demoSales(await loadDemo(now, false), now, settings),
      status,
    ).slice(0, limit);
  // A closed session never charges again. An open one is re-read from Ivora,
  // since it may have finished since this instance indexed it.
  const views = await recentSales(
    liveStoreDeps(settings),
    (s) => status !== "charging" || !isClosedSession(s),
    POS_LIST_LIMIT,
  );
  return posSales(views, status).slice(0, limit);
}

/**
 * Email the store receipt to an address the cashier typed. The address is
 * used for this send only: never stored, logged or put in a URL. Demo mode
 * never sends; it returns the email that would be sent.
 */
export async function emailReceipt(
  saleId: string,
  to: string,
  requestId: string,
  settings: Settings,
  now = Date.now(),
): Promise<EmailResult> {
  if (!settings.emailReceipts)
    throw new UserError(
      404,
      "email_off",
      "Emailed receipts are off. Set RESEND_API_KEY and RECEIPT_EMAIL_FROM.",
    );
  if (!isEmailAddress(to))
    throw new UserError(400, "invalid_email", "Check the email address.");
  const view = await sale(saleId, settings, now);
  if (view.phase !== "done")
    throw new UserError(
      409,
      "receipt_not_ready",
      "Email the receipt when charging has ended.",
    );
  const email = receiptEmail(view, to, {
    siteName: settings.demo
      ? DEMO_SITE_NAME
      : process.env.SITE_NAME || "EV charging",
    timeZone: settings.siteTimeZone,
  });
  return deliverReceipt(email, `forecourt:store:${saleId}:email:${requestId}`, {
    demo: settings.demo,
    mailer: settings.demo ? null : receiptMailer(settings),
    sale: saleId,
  });
}
