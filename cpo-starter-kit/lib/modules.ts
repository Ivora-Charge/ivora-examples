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
      "Step-by-step setup: connect Ivora, add your first site and charger, and print QR stickers.",
    status: "coming-soon",
  },
  {
    slug: "chargers",
    href: "/chargers",
    label: "Chargers",
    summary: "Every charger and connector, its status, and remote actions.",
    status: "coming-soon",
  },
  {
    slug: "live",
    href: "/live",
    label: "Live",
    summary: "Sessions in progress, power and energy as they happen.",
    status: "coming-soon",
  },
  {
    slug: "pricing",
    href: "/pricing",
    label: "Pricing",
    summary: "Tariffs per site and connector, in your currency.",
    status: "coming-soon",
  },
  {
    slug: "reports",
    href: "/reports",
    label: "Reports",
    summary: "Energy and revenue per site, charger and month, with CSV export.",
    status: "coming-soon",
  },
  {
    slug: "team",
    href: "/team",
    label: "Team",
    summary: "Invite staff and choose what each person may do.",
    status: "coming-soon",
  },
  {
    slug: "settings",
    href: "/settings",
    label: "Settings",
    summary: "Your brand, domain, and connected services.",
    status: "coming-soon",
  },
];

export function moduleBySlug(slug: string): Module {
  const m = MODULES.find((x) => x.slug === slug);
  if (!m) throw new Error(`Unknown module ${slug}`);
  return m;
}
