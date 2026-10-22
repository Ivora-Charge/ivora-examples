/** The app's sections. Status changes to "ready" as each part of the kit lands. */
export interface Module {
  slug: string;
  href: `/${string}`;
  label: string;
  summary: string;
  status: "ready" | "coming-soon";
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
    slug: "team",
    href: "/team",
    label: "Team",
    summary: "Invite staff and choose what each person may do.",
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

export function moduleBySlug(slug: string): Module {
  const m = MODULES.find((x) => x.slug === slug);
  if (!m) throw new Error(`Unknown module ${slug}`);
  return m;
}
