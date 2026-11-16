import { isHostUser, type Member } from "./hosts";

/** The app's sections. Status changes to "ready" as each part of the kit lands. */
export interface Module {
  slug: string;
  href: `/${string}`;
  label: string;
  summary: string;
  status: "ready" | "coming-soon";
  /** An optional module, shown only when its flag is on (FLEET_MODULE for "fleet"). */
  optional?: "fleet";
}

export const MODULES: Module[] = [
  {
    slug: "overview",
    href: "/",
    label: "Overview",
    summary: "Your sites, chargers and recent sessions at a glance.",
    status: "ready",
  },
  {
    slug: "onboarding",
    href: "/onboarding",
    label: "Onboarding",
    summary:
      "Step-by-step setup: company details, your brand on the driver payment pages, and Stripe.",
    status: "ready",
  },
  {
    slug: "chargers",
    href: "/chargers",
    label: "Chargers",
    summary:
      "Add and test chargers, set their connection password and print QR stickers.",
    status: "ready",
  },
  {
    slug: "live",
    href: "/live",
    label: "Live",
    summary:
      "A map and list of chargers with live status, faults and sessions; start, stop, reset and unlock.",
    status: "ready",
  },
  {
    slug: "pricing",
    href: "/pricing",
    label: "Pricing",
    summary:
      "Tariffs per charger and connector: per-kWh, time-of-use, idle and session fees, free and private chargers.",
    status: "ready",
  },
  {
    slug: "reports",
    href: "/reports",
    label: "Reports",
    summary:
      "Sessions, energy, success rate and billed revenue over a period; a sessions table with CSV export; your Stripe payouts.",
    status: "ready",
  },
  {
    slug: "cards",
    href: "/cards",
    label: "Cards",
    summary:
      "RFID cards per driver or vehicle: add, import, block or expire them, with each card's sessions and energy.",
    status: "ready",
    optional: "fleet",
  },
  {
    slug: "team",
    href: "/team",
    label: "Team",
    summary: "Invite staff and choose what each person may do.",
    status: "ready",
  },
  {
    slug: "hosts",
    href: "/hosts",
    label: "Hosts",
    summary:
      "Site hosts (shops, hotels, car parks): their sites, their own logins and what each host may do.",
    status: "ready",
  },
  {
    slug: "settings",
    href: "/settings",
    label: "Settings",
    summary: "Company details, brand, card payments and roaming.",
    status: "ready",
  },
];

/** The sections a host user sees: their sites' network, and what their switches allow. */
const HOST_SECTIONS = ["overview", "live", "chargers", "reports"];

/**
 * The sections to show the signed-in user: optional ones only when their flag is on;
 * for a host user, their network's sections, Pricing with "edit prices" and Team with
 * "invite further users". Display only: every page checks access on the server.
 */
export function modulesFor(m: Member, flags: { fleet: boolean }): Module[] {
  const all = visibleModules(flags);
  if (!isHostUser(m)) return m.role === "host" ? [] : all;
  const p = m.host.permissions;
  return all.filter(
    (x) =>
      HOST_SECTIONS.includes(x.slug) ||
      (x.slug === "pricing" && p.editPrices) ||
      (x.slug === "team" && p.invite),
  );
}

/** The sections to show: optional ones only when their flag is on. */
export function visibleModules(flags: { fleet: boolean }): Module[] {
  return MODULES.filter((m) => m.optional !== "fleet" || flags.fleet);
}

export function moduleBySlug(slug: string): Module {
  const m = MODULES.find((x) => x.slug === slug);
  if (!m) throw new Error(`Unknown module ${slug}`);
  return m;
}
