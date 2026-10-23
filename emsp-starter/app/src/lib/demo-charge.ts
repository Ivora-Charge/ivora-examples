import type {
  Card,
  CardSetup,
  Charge,
  CommandView,
  Favourite,
  HistoryItem,
  PaymentView,
  Place,
  ProblemReport,
  Quote,
  Receipt,
  SessionState,
  SessionView,
} from "./charging";
import type { LiveData } from "./live";
import type { LocationDetail } from "./types";

/**
 * The offline demo's charging: the whole flow on the device, with the sample chargers
 * of the built-in mock CPO, in the same shapes as the server's API. Nothing is sent
 * anywhere and no card is charged.
 *
 * - A start is accepted at once; the session's energy rises at DEMO_KWH_PER_SECOND
 *   (faster than a real charger) and costs the connector's price per kWh.
 * - The demo hold is DEMO_HOLD (€25.00). What is "charged" is the session's cost,
 *   never more than the hold, exactly as the server's payments settle.
 * - The second demo card declines a higher hold: once the cost reaches
 *   DEMO_DECLINE_AT of the hold, the session stops and says why
 *   (`hold_increment_declined`), as the server does live.
 * - A stopped session's receipt is ready at once (the CDR comes later in real life).
 */
export const DEMO_KWH_PER_SECOND = 0.2;
export const DEMO_HOLD = 2500;
export const DEMO_DECLINE_AT = 0.1;
export const DEMO_CARD_ID = "pm_demo4242";
export const DEMO_DECLINE_CARD_ID = "pm_demo0341";
const DEMO_MESSAGE = "Demo mode: nothing was sent to a charger.";

export class DemoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DemoError";
  }
}

type DemoCharge = {
  id: string;
  requestId: string;
  location: LocationDetail;
  evseUid: string;
  connectorId: string;
  currency: string;
  /** Price per kWh in ten-thousandths of the currency, VAT included. */
  priceE4: number;
  cardId: string;
  startedAt: number;
  endedAt: number | null;
  stoppedByCard: boolean;
};

let seq = 0;
const newId = (now: number) => `demo-${now.toString(36)}-${++seq}`;

const iso = (ms: number) => new Date(ms).toISOString();

export function createDemoCharging(
  locations: LocationDetail[],
  now: () => number = Date.now,
) {
  const charges: DemoCharge[] = [];
  const favourites = new Map<string, number>();
  const reports: (ProblemReport & { id: string })[] = [];
  let defaultCard = DEMO_CARD_ID;

  const findLocation = (id: string) => {
    const l = locations.find((x) => x.id === id);
    if (!l) throw new DemoError("not_found", "Unknown location.");
    return l;
  };
  const placeOf = (l: LocationDetail): Place => ({
    id: l.id,
    name: l.name,
    address: l.address,
    city: l.city,
  });

  /** The connector's energy price incl. VAT, or a demo price without one. */
  function price(l: LocationDetail, evseUid: string, connectorId: string) {
    const c = l.evses
      .find((e) => e.uid === evseUid)
      ?.connectors.find((x) => x.id === connectorId);
    const energy = c?.price?.components.find((p) => p.type === "ENERGY");
    return {
      currency: c?.price?.currency ?? "EUR",
      priceE4: energy?.priceE4 ?? 5000,
    };
  }

  const minorDigits = (currency: string) => {
    try {
      return (
        new Intl.NumberFormat("en", {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits ?? 2
      );
    } catch {
      return 2;
    }
  };

  function progress(c: DemoCharge, at = now()) {
    const end = c.endedAt ?? at;
    const seconds = Math.max(0, (end - c.startedAt) / 1000);
    const kwh = Math.round(seconds * DEMO_KWH_PER_SECOND * 10_000) / 10_000;
    const cost = Math.round(
      (kwh * c.priceE4) / 10 ** (4 - minorDigits(c.currency)),
    );
    return { kwh, cost, seconds };
  }

  /** Moves a running charge on: the declining card stops it once the cost is high enough. */
  function advance(c: DemoCharge) {
    if (c.endedAt !== null || c.cardId !== DEMO_DECLINE_CARD_ID) return;
    const { cost } = progress(c);
    if (cost < Math.ceil(DEMO_HOLD * DEMO_DECLINE_AT)) return;
    // Stop at the moment the cost reached the threshold.
    const perSecond =
      (DEMO_KWH_PER_SECOND * c.priceE4) / 10 ** (4 - minorDigits(c.currency));
    c.endedAt = Math.min(
      now(),
      c.startedAt + Math.ceil((DEMO_HOLD * DEMO_DECLINE_AT) / perSecond) * 1000,
    );
    c.stoppedByCard = true;
  }

  const get = (id: string) => {
    const c = charges.find((x) => x.id === id);
    if (!c) throw new DemoError("not_found", "No such charge.");
    advance(c);
    return c;
  };

  const command = (c: DemoCharge): CommandView => ({
    id: c.id,
    type: "START_SESSION",
    requestId: c.requestId,
    status: "succeeded",
    pending: false,
    result: "ACCEPTED",
    message: "The charger accepted the start.",
    peerMessage: DEMO_MESSAGE,
    alternatives: [],
    sessionId: `D${c.id.replace(/-/g, "").slice(0, 30)}`,
    createdAt: iso(c.startedAt),
    finishedAt: iso(c.startedAt),
  });

  function payment(c: DemoCharge): PaymentView {
    const { cost } = progress(c);
    const settled = c.endedAt !== null;
    const charged = Math.min(cost, DEMO_HOLD);
    return {
      id: `pay-${c.id}`,
      chargeId: c.id,
      status: !settled ? "held" : charged > 0 ? "captured" : "released",
      currency: c.currency,
      holdAmount: DEMO_HOLD,
      authorizedAmount: DEMO_HOLD,
      capturedAmount: settled ? charged : 0,
      refundedAmount: 0,
      sessionCost: settled ? cost : null,
      stopReason: c.stoppedByCard
        ? "Stopped because your card did not allow a higher payment hold."
        : null,
      stopCode: c.stoppedByCard ? "hold_increment_declined" : null,
      underReview: c.stoppedByCard,
      demo: true,
      createdAt: iso(c.startedAt),
    };
  }

  function session(c: DemoCharge): SessionView {
    const { kwh, cost } = progress(c);
    const open = c.endedAt === null;
    return {
      id: `session-${c.id}`,
      status: open ? "ACTIVE" : "COMPLETED",
      open,
      kwh,
      startedAt: iso(c.startedAt),
      endedAt: open ? null : iso(c.endedAt!),
      currency: c.currency,
      cost: { amount: cost, vatIncluded: true },
      stopCode: c.stoppedByCard ? "hold_increment_declined" : null,
    };
  }

  function live(c: DemoCharge): LiveData {
    if (c.endedAt !== null) return {};
    const minutes = (now() - c.startedAt) / 60_000;
    const at = iso(now());
    return {
      socPercent: Math.min(95, Math.round(30 + minutes * 0.8)),
      socMeasuredAt: at,
      powerKw: 48.5,
      powerMeasuredAt: at,
    };
  }

  const open = () => charges.find((c) => (advance(c), c.endedAt === null));

  return {
    cards(): Card[] {
      const exp = new Date(now()).getUTCFullYear() + 3;
      return [
        {
          id: DEMO_CARD_ID,
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: exp,
          isDefault: defaultCard === DEMO_CARD_ID,
        },
        {
          id: DEMO_DECLINE_CARD_ID,
          brand: "mastercard",
          last4: "0341",
          expMonth: 12,
          expYear: exp,
          isDefault: defaultCard === DEMO_DECLINE_CARD_ID,
        },
      ];
    },
    setDefaultCard(id: string) {
      if (id !== DEMO_CARD_ID && id !== DEMO_DECLINE_CARD_ID)
        throw new DemoError("not_found", "No such card.");
      defaultCard = id;
    },
    removeCard(): never {
      throw new DemoError(
        "demo_mode",
        "Demo mode: the demo cards cannot be removed.",
      );
    },
    setupCard(): CardSetup {
      return {
        mode: "demo",
        customerId: null,
        setupIntentClientSecret: null,
        ephemeralKeySecret: null,
        publishableKey: null,
      };
    },
    quote(locationId: string, evseUid?: string, connectorId?: string): Quote {
      const l = findLocation(locationId);
      const evse = l.evses.find((e) => e.uid === evseUid) ?? l.evses[0];
      const { currency } = price(
        l,
        evse.uid,
        connectorId ?? evse.connectors[0].id,
      );
      return {
        currency,
        holdAmount: DEMO_HOLD,
        mayRaise: true,
        demo: true,
        hasCard: true,
      };
    },
    start(input: {
      requestId: string;
      locationId: string;
      evseUid?: string;
      connectorId?: string;
    }): {
      state: "created" | "replayed" | "busy";
      command: CommandView;
      payment: PaymentView;
    } {
      const again = charges.find((c) => c.requestId === input.requestId);
      if (again)
        return {
          state: "replayed",
          command: command(again),
          payment: payment(again),
        };
      const busy = open();
      if (busy)
        return {
          state: "busy",
          command: command(busy),
          payment: payment(busy),
        };
      const l = findLocation(input.locationId);
      const evse = l.evses.find((e) => e.uid === input.evseUid) ?? l.evses[0];
      const connectorId = input.connectorId ?? evse.connectors[0].id;
      const c: DemoCharge = {
        id: newId(now()),
        requestId: input.requestId,
        location: l,
        evseUid: evse.uid,
        connectorId,
        ...price(l, evse.uid, connectorId),
        cardId: defaultCard,
        startedAt: now(),
        endedAt: null,
        stoppedByCard: false,
      };
      charges.unshift(c);
      return { state: "created", command: command(c), payment: payment(c) };
    },
    charge(id: string): { command: CommandView; payment: PaymentView } {
      const c = get(id);
      return { command: command(c), payment: payment(c) };
    },
    active(): Charge | null {
      const c = open();
      return c
        ? {
            command: command(c),
            payment: payment(c),
            place: placeOf(c.location),
          }
        : null;
    },
    session(id: string): SessionState {
      const c = get(id);
      return {
        session: session(c),
        live: live(c),
        payment: payment(c),
        place: placeOf(c.location),
      };
    },
    stop(id: string): { state: "created"; command: CommandView } {
      const c = get(id);
      if (c.endedAt === null) c.endedAt = now();
      return {
        state: "created",
        command: {
          ...command(c),
          type: "STOP_SESSION",
          result: "ACCEPTED",
          message: "The charger accepted the stop.",
        },
      };
    },
    history(): HistoryItem[] {
      return charges.map((c) => {
        advance(c);
        const p = payment(c);
        return {
          chargeId: c.id,
          createdAt: iso(c.startedAt),
          status: "succeeded",
          place: placeOf(c.location),
          evseUid: c.evseUid,
          session: session(c),
          payment: {
            status: p.status,
            currency: p.currency,
            held: p.authorizedAmount,
            charged: p.capturedAmount,
            refunded: 0,
          },
          receipt: c.endedAt !== null,
          stopCode: p.stopCode,
        };
      });
    },
    receipt(id: string): Receipt {
      const c = get(id);
      if (c.endedAt === null)
        throw new DemoError("http_409", "The receipt is not ready yet.");
      const p = payment(c);
      const { kwh, cost, seconds } = progress(c);
      const evse = c.location.evses.find((e) => e.uid === c.evseUid);
      const connector = evse?.connectors.find((x) => x.id === c.connectorId);
      return {
        chargeId: c.id,
        locationId: c.location.id,
        paymentId: p.id,
        cdrId: `cdr-${c.id}`,
        place: {
          name: c.location.name,
          address: c.location.address,
          city: c.location.city,
          evseId: evse?.evse_id ?? c.evseUid,
          connector: connector?.standard ?? "",
          powerType: connector?.power_type ?? "",
        },
        startedAt: iso(c.startedAt),
        endedAt: iso(c.endedAt),
        kwh,
        hours: Math.round((seconds / 3600) * 10_000) / 10_000,
        currency: c.currency,
        sessionCost: { amount: cost, vatIncluded: true },
        held: DEMO_HOLD,
        charged: p.capturedAmount,
        refunded: 0,
        paymentStatus: p.status,
        shortfall: cost > DEMO_HOLD ? cost - DEMO_HOLD : null,
        underReview: p.underReview,
        stopReason: p.stopReason,
        stopCode: p.stopCode,
        demo: true,
      };
    },
    favourites(): Favourite[] {
      return [...favourites.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, at]) => ({
          locationId: id,
          createdAt: iso(at),
          place: placeOf(findLocation(id)),
        }));
    },
    setFavourite(locationId: string, on: boolean) {
      findLocation(locationId);
      if (on) {
        if (!favourites.has(locationId))
          favourites.set(locationId, now() + favourites.size);
      } else favourites.delete(locationId);
    },
    report(r: ProblemReport): { id: string } {
      findLocation(r.locationId);
      const id = newId(now());
      reports.push({ ...r, id });
      return { id };
    },
    /** For tests: what the demo kept. */
    reports: () => reports.map((r) => ({ ...r })),
  };
}

export type DemoCharging = ReturnType<typeof createDemoCharging>;
