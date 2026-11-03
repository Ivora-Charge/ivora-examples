import { formatMinor } from "@/lib/money";
import type { ReturnedSession } from "@/lib/server/checkout/service";

/**
 * The demo's sample driver sessions (/s/demo-starting, demo-charging, demo-stopping,
 * demo-finished): fixed sample data, no cookie, no checkout record and no call to
 * Ivora. They show what a driver sees on the operator's own domain after paying.
 */
export const DEMO_SESSION_IDS = [
  "demo-starting",
  "demo-charging",
  "demo-stopping",
  "demo-finished",
] as const;
export type DemoSessionId = (typeof DEMO_SESSION_IDS)[number];

const usd = (m: number) => formatMinor(m, "USD");
const PLACE = "DEMO-HARBOUR-01, connector 1";

export function demoSession(id: string): ReturnedSession | null {
  const base = {
    id,
    place: PLACE,
    notice: null,
    canStart: false,
    canStop: false,
    live: false,
    receipt: null,
    energyKwh: null,
    cost: null,
  };
  switch (id) {
    case "demo-starting":
      return {
        ...base,
        stage: "starting",
        label: "Starting",
        detail: "Your payment is confirmed. The charger is being started.",
        live: true,
      };
    case "demo-charging":
      return {
        ...base,
        stage: "charging",
        label: "Charging",
        detail: "Your car is charging.",
        energyKwh: "7.45",
        cost: usd(361),
        canStop: true,
        live: true,
        notice: `Charging stops by itself at about ${usd(2250)}, so your card hold of ${usd(2500)} covers the session.`,
      };
    case "demo-stopping":
      return {
        ...base,
        stage: "stopping",
        label: "Stopping",
        detail:
          "The stop was sent to the charger. Your final bill is settled when it confirms.",
        energyKwh: "9.12",
        cost: usd(420),
        live: true,
      };
    case "demo-finished":
      return {
        ...base,
        stage: "finished",
        label: "Finished",
        detail:
          "Your card was charged for this session, and the rest of the hold was released.",
        energyKwh: "9.12",
        receipt: {
          energyKwh: "9.12",
          total: usd(420),
          charged: usd(420),
          released: usd(2080),
          hold: usd(2500),
        },
      };
    default:
      return null;
  }
}
