import "server-only";
import type { Onboarding, StripeResult } from "./service";

export interface ChecklistItem {
  key: "company" | "brand" | "stripe" | "charger" | "price";
  label: string;
  /** soon: the part of the kit that does this step is not built yet. */
  state: "done" | "todo" | "soon";
  detail: string;
  href: string;
}

/**
 * The home page's setup checklist. `chargers` is the number of chargers in the Ivora
 * project (null when it could not be read); `prices` the number of tariffs live in
 * Ivora and how many chargers have one.
 */
export function setupChecklist(
  o: Onboarding,
  stripe: StripeResult,
  chargers: number | null,
  prices: { tariffs: number; assigned: number } = { tariffs: 0, assigned: 0 },
): ChecklistItem[] {
  const stripeState = stripe.ok ? stripe.view.state : null;
  return [
    {
      key: "company",
      label: "Company details",
      state: o.companyDone ? "done" : "todo",
      detail: o.companyDone
        ? `${o.profile.name}, ${o.profile.timeZone}, ${o.profile.currency}`
        : "Name, support email, time zone and currency.",
      href: "/onboarding?step=company",
    },
    {
      key: "brand",
      label: "Brand",
      state: o.brandDone ? "done" : "todo",
      detail: o.brandDone
        ? "Your colour is on the driver payment pages."
        : o.profile.primaryColor && !o.inSync
          ? "Saved, but not on the driver payment pages yet."
          : "Colour and logo for the driver payment pages.",
      href: "/onboarding?step=brand",
    },
    {
      key: "stripe",
      label: "Stripe ready",
      state: stripeState === "ready" ? "done" : "todo",
      detail: stripe.ok
        ? `${stripe.view.label}.`
        : "Couldn't read the Stripe status.",
      href: "/onboarding?step=payments",
    },
    {
      key: "charger",
      label: "First charger",
      state: chargers ? "done" : "todo",
      detail: chargers
        ? `${chargers} ${chargers === 1 ? "charger" : "chargers"} in your Ivora project.`
        : "Add a charger, connect it and run the connection test.",
      href: "/chargers",
    },
    {
      key: "price",
      label: "First price",
      state: prices.tariffs && prices.assigned ? "done" : "todo",
      detail: !prices.tariffs
        ? "Create a tariff: price per kWh, time-of-use, idle fee, or free."
        : !prices.assigned
          ? "Assign your tariff to a charger."
          : `${prices.tariffs} ${prices.tariffs === 1 ? "tariff" : "tariffs"}, on ${prices.assigned} ${prices.assigned === 1 ? "charger" : "chargers"}.`,
      href: "/pricing",
    },
  ];
}
