import "server-only";
import { DEMO_DECLINE_CARD_ID } from "@/lib/accounts/registry";
import { onCommandEvent, type CommandEvent } from "@/lib/commands/events";
import type { Command } from "@/lib/commands/store";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { primaryTariff } from "@/lib/locations/pricing";
import { tariffsFor, tariffsOfLocation } from "@/lib/locations/search";
import { cdrForSession } from "@/lib/mock-cpo/sample-data";
import { sameId, type Location } from "@/lib/ocpi/locations";
import type { Session } from "@/lib/ocpi/session-objects";
import type { Peer } from "@/lib/ocpi/store";
import { ocpiTimestamp } from "@/lib/ocpi/types";
import { commandDepsOf } from "@/lib/payments/listen";
import { cdrAmount } from "@/lib/payments/money";
import { paymentDeps, type PaymentDeps } from "@/lib/payments/registry";
import { declineIncrement } from "@/lib/payments/settle";
import { isDemo } from "@/lib/server/demo";
import { patchSession, recordCdr, recordSession } from "@/lib/sessions/record";
import type { StoredSession } from "@/lib/sessions/store";
import { sessionOfStart } from "./charges";

/**
 * Demo mode's charging, so the app's whole flow runs against the built-in mock CPO with
 * nothing sent anywhere. Demo mode accepts every START_SESSION and STOP_SESSION for the
 * mock CPO at once (lib/commands); this file plays the CPO's side after that, through
 * the Sessions module's own code paths, so payments, receipts and notifications run as
 * they do live:
 *
 * - a START_SESSION that succeeded gets a session, linked by its authorization_reference;
 * - while the app reads it, the session's energy and cost rise (`advanceDemoCharge`),
 *   faster than a real charger, at the connector's tariff;
 * - a STOP_SESSION that succeeded completes the session, and its CDR settles the payment
 *   (the demo payment: no card is charged) and makes the receipt.
 *
 * The demo card that declines raises (DEMO_DECLINE_CARD_ID) shows `hold_increment_declined`:
 * once the running cost reaches a tenth of the hold, its raise is declined, and the
 * payments module stops the session exactly as it does live.
 *
 * Nothing here runs outside demo mode, or for any peer but the mock CPO.
 */
/** The same pace as the app's offline demo (app/src/lib/demo-charge.ts; a test keeps them equal). */
export const DEMO_KWH_PER_SECOND = 0.2;
/** The demo card that declines raises declines once the cost reaches this share of the hold. */
export const DEMO_DECLINE_AT = 0.1;

const demoPeer = { id: DEMO_PEER_ID } as Peer;

const applies = (c: Pick<Command, "peerId">) =>
  isDemo() && c.peerId === DEMO_PEER_ID;

const sessionDeps = (deps: PaymentDeps) => ({
  sessions: deps.sessions,
  commands: deps.commands,
  tokens: deps.tokens,
  peers: deps.peers,
  now: deps.now,
  actor: "demo",
});

async function locationOf(c: Command, deps: PaymentDeps) {
  return deps.locations.getLocation({
    peerId: c.peerId,
    countryCode: c.toCountryCode,
    partyId: c.toPartyId,
    id: c.locationId ?? "",
  });
}

/** The connector's energy price and VAT, from its tariff; a demo price without one. */
async function energyPrice(
  stored: Awaited<ReturnType<typeof locationOf>>,
  evseUid: string,
  connectorId: string,
  deps: PaymentDeps,
): Promise<{ price: number; vat?: number }> {
  if (!stored) return { price: 0.5 };
  const connector = stored.location.evses
    ?.find((e) => sameId(e.uid, evseUid))
    ?.connectors.find((x) => sameId(x.id, connectorId));
  const tariff = primaryTariff(
    connector?.tariff_ids,
    tariffsOfLocation(stored, await tariffsFor(deps.locations, [stored])),
  );
  const energy = tariff?.elements
    .flatMap((e) => e.price_components)
    .find((p) => p.type === "ENERGY");
  return energy ? { price: energy.price, vat: energy.vat } : { price: 0.5 };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Energy and cost after `seconds` of demo charging. */
function progress(
  seconds: number,
  price: { price: number; vat?: number },
): Pick<Session, "kwh" | "total_cost"> {
  const kwh = round4(Math.max(0, seconds) * DEMO_KWH_PER_SECOND);
  const excl = round4(kwh * price.price);
  return {
    kwh,
    total_cost:
      price.vat === undefined
        ? { excl_vat: excl }
        : { excl_vat: excl, incl_vat: round4(excl * (1 + price.vat / 100)) },
  };
}

const nowOf = (deps: PaymentDeps) => deps.now?.() ?? new Date();

/** Gives a demo start that succeeded its session, as the mock CPO would push it. */
export async function startDemoSession(
  c: Command,
  deps: PaymentDeps = paymentDeps("demo"),
): Promise<StoredSession | null> {
  if (!applies(c) || c.type !== "START_SESSION" || c.status !== "succeeded")
    return null;
  const held = await sessionOfStart(c, deps.sessions);
  if (held) return held;
  const stored = await locationOf(c, deps);
  const location: Location | undefined = stored?.location;
  const evse =
    location?.evses?.find((e) => !c.evseUid || sameId(e.uid, c.evseUid)) ??
    undefined;
  const token = (await deps.tokens.listByDriver(c.driverRef)).find(
    (t) => t.type === "APP_USER",
  );
  if (!location || !evse || !token || !c.authorizationReference) return null;
  const at = ocpiTimestamp(nowOf(deps));
  const session: Session = {
    country_code: c.toCountryCode,
    party_id: c.toPartyId,
    id: `D${c.id.replace(/-/g, "").slice(0, 30)}`,
    start_date_time: at,
    kwh: 0,
    cdr_token: {
      country_code: token.countryCode,
      party_id: token.partyId,
      uid: token.uid,
      type: token.type,
      contract_id: token.contractId,
    },
    auth_method: "COMMAND",
    authorization_reference: c.authorizationReference,
    location_id: location.id,
    evse_uid: evse.uid,
    connector_id: c.connectorId ?? evse.connectors[0].id,
    currency: (await deps.payments.getByCommand(c.id))?.currency ?? "EUR",
    status: "ACTIVE",
    last_updated: at,
  };
  return (await recordSession(demoPeer, session, sessionDeps(deps))).session;
}

/**
 * Moves a running demo session on: its energy and cost so far. With the demo card that
 * declines raises, declines one once the cost reaches DEMO_DECLINE_AT of the hold.
 * Does nothing outside demo mode.
 */
export async function advanceDemoCharge(
  c: Command,
  deps: PaymentDeps = paymentDeps("demo"),
): Promise<void> {
  if (!applies(c) || c.type !== "START_SESSION" || c.status !== "succeeded")
    return;
  let s =
    (await sessionOfStart(c, deps.sessions)) ??
    (await startDemoSession(c, deps));
  if (!s || s.completedAt || s.session.status !== "ACTIVE") return;
  const now = nowOf(deps);
  const seconds =
    (now.getTime() - Date.parse(s.session.start_date_time)) / 1000;
  const price = await energyPrice(
    await locationOf(c, deps),
    s.session.evse_uid,
    s.session.connector_id,
    deps,
  );
  s = (
    await patchSession(
      demoPeer,
      {
        peerId: DEMO_PEER_ID,
        countryCode: s.session.country_code,
        partyId: s.session.party_id,
        sessionId: s.session.id,
      },
      { ...progress(seconds, price), last_updated: ocpiTimestamp(now) },
      sessionDeps(deps),
    )
  ).session;

  const p = await deps.payments.getByCommand(c.id);
  if (
    !p ||
    p.status !== "held" ||
    p.paymentMethodId !== DEMO_DECLINE_CARD_ID ||
    p.increments > 0 ||
    !s.session.total_cost
  )
    return;
  const cost = cdrAmount(s.session.total_cost, s.session.currency).minor;
  if (cost >= Math.ceil(p.authorizedAmount * DEMO_DECLINE_AT))
    await declineIncrement(s, p, deps, () => commandDepsOf(deps));
}

/** Completes a demo session the driver (or the payments module) stopped, with its CDR. */
export async function completeDemoSession(
  stop: Command,
  deps: PaymentDeps = paymentDeps("demo"),
): Promise<void> {
  if (!applies(stop) || stop.type !== "STOP_SESSION" || !stop.sessionId) return;
  const s = (
    await deps.sessions.findSessions(stop.peerId, stop.sessionId)
  ).find((x) => x.driverRef === stop.driverRef);
  if (!s || s.completedAt) return;
  const start = s.commandId ? await deps.commands.get(s.commandId) : null;
  const stored = start ? await locationOf(start, deps) : null;
  if (!stored) return;
  const now = nowOf(deps);
  const seconds =
    (now.getTime() - Date.parse(s.session.start_date_time)) / 1000;
  const price = await energyPrice(
    stored,
    s.session.evse_uid,
    s.session.connector_id,
    deps,
  );
  const end = ocpiTimestamp(now);
  const done = (
    await patchSession(
      demoPeer,
      {
        peerId: DEMO_PEER_ID,
        countryCode: s.session.country_code,
        partyId: s.session.party_id,
        sessionId: s.session.id,
      },
      {
        ...progress(seconds, price),
        status: "COMPLETED",
        end_date_time: end,
        last_updated: end,
      },
      sessionDeps(deps),
    )
  ).session;
  await recordCdr(
    demoPeer,
    cdrForSession(done.session, stored.location),
    "push",
    sessionDeps(deps),
  );
}

async function onCommand(event: CommandEvent) {
  if (!isDemo() || event.command.status !== "succeeded") return;
  const deps = paymentDeps("demo");
  const c = await deps.commands.get(event.command.id);
  if (!c) return;
  if (c.type === "START_SESSION") await startDemoSession(c, deps);
  else await completeDemoSession(c, deps);
}

const holder = globalThis as unknown as { __emspDemoCharging?: boolean };

/** Plays the mock CPO's side of demo charges, in this server process. Once. */
export function installDemoCharging(): () => void {
  if (holder.__emspDemoCharging) return () => undefined;
  holder.__emspDemoCharging = true;
  const off = onCommandEvent(onCommand);
  return () => {
    off();
    holder.__emspDemoCharging = false;
  };
}
