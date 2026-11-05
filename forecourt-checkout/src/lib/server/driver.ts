import "server-only";
import {
  DEMO_READY,
  demoTariff,
  demoCharger,
  demoView,
  isDemoId,
  startDemoSession,
  stopDemoSession,
  unplugDemoSession,
} from "../demo";
import type { Settings } from "../settings";
import { chargerLabel } from "../store";
import { localQuote } from "../tariff";
import { publicView, type SessionView } from "../view";
import { liveDeps } from "./services";
import {
  chargerPage,
  createCheckout,
  loadChargerPage,
  reconcile,
  requestStop,
  UserError,
  type ChargerPage,
} from "./sessions";

// One entry point per driver action. Demo mode answers from src/lib/demo.ts and
// never builds the live dependencies, so it cannot reach Ivora or Stripe.

const notFound = () =>
  new UserError(404, "session_not_found", "Charging session not found.");

export async function chargerFor(
  code: string,
  connector: number,
  settings: Settings,
): Promise<ChargerPage> {
  if (!settings.demo)
    return loadChargerPage(code, connector, liveDeps(settings));
  const charger = demoCharger(code);
  const c = charger?.connectors.find((x) => x.number === connector);
  if (!charger || !c)
    throw new UserError(
      404,
      "charger_not_found",
      "This demo charger does not exist.",
    );
  return chargerPage({
    demo: true,
    code,
    label: chargerLabel(code, connector, charger.connectors.length),
    name: charger.name,
    connector: {
      number: c.number,
      label: `${c.label} · connector ${c.number}`,
      maxPowerW: c.maxPowerW,
      status: charger.online ? c.status : "Offline",
      available: charger.online && DEMO_READY.has(c.status),
    },
    tariff: demoTariff(charger),
    quote: localQuote(demoTariff(charger), {
      energyWh: settings.typicalSessionKwh * 1000,
      chargingSeconds: settings.typicalSessionMinutes * 60,
      idleSeconds: 0,
    }),
    // The CAD sample has no cashier console, so no pay-at-the-counter option.
    settings: charger.tariff ? { ...settings, payInStore: false } : settings,
  });
}

/** Returns where the browser goes next: Stripe Checkout, or the demo session page. */
export async function pay(
  input: { code: string; connector: number; requestId: string },
  settings: Settings,
  now = Date.now(),
): Promise<{ id: string; url: string }> {
  if (settings.demo) {
    try {
      const id = startDemoSession(input.code, input.connector, now);
      return { id, url: `/s/${id}` };
    } catch (error) {
      throw new UserError(409, "connector_not_ready", (error as Error).message);
    }
  }
  return createCheckout(input, liveDeps(settings));
}

export async function sessionView(
  id: string,
  settings: Settings,
  now = Date.now(),
): Promise<SessionView> {
  if (isDemoId(id)) {
    const view = demoView(id, now, settings);
    if (!view) throw notFound();
    return publicView(view);
  }
  if (settings.demo) throw notFound();
  return publicView(await reconcile(id, liveDeps(settings)));
}

export async function stop(id: string, settings: Settings, now = Date.now()) {
  if (isDemoId(id)) {
    const next = stopDemoSession(id, now);
    const view = demoView(next, now, settings);
    if (!view) throw notFound();
    return publicView(view);
  }
  if (settings.demo) throw notFound();
  return publicView(await requestStop(id, liveDeps(settings)));
}

/** Demo only: simulate the driver unplugging after charging finished. */
export async function unplug(id: string, settings: Settings, now = Date.now()) {
  if (!isDemoId(id))
    throw new UserError(
      400,
      "demo_only",
      "Unplugging is detected from the charger in live mode.",
    );
  const view = demoView(unplugDemoSession(id, now), now, settings);
  if (!view) throw notFound();
  return publicView(view);
}
