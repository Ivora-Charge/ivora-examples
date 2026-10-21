import "server-only";
import { cookies } from "next/headers";
import {
  decodeDemoStore,
  demoAuthorize,
  demoConsole,
  demoCounter,
  demoGiveChange,
  demoMarkPaid,
  demoPrepayQuote,
  demoSaleById,
  demoStop,
  demoUnplug,
  DEMO_STORE_COOKIE,
  encodeDemoStore,
  type DemoStore,
} from "../demo-store";
import type { Settings } from "../settings";
import type { DriverSale, PaymentMethod, SaleTerms, SaleView } from "../store";
import { driverSale, SaleError } from "../store";
import { liveStoreDeps } from "./services";
import {
  authorizeSale,
  consoleState,
  counterState,
  giveChange,
  markSalePaid,
  prepayQuote,
  saleById,
  stopSale,
  type ConsoleState,
  type CounterState,
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

export async function cashierConsole(
  settings: Settings,
  now = Date.now(),
): Promise<ConsoleState> {
  if (settings.demo)
    return demoConsole(await loadDemo(now, true), now, settings);
  return consoleState(liveStoreDeps(settings));
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
