"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAdmin } from "./admin-context";
import { Icon, Mark, type IconName } from "./kit";
import { useSetup } from "./setup-context";

/**
 * The frame every admin page shares, as in the design: a top bar and a tab bar with
 * five places on a phone; from 60rem a labelled rail on the left.
 *
 * The first place is Setup until all six checks pass, and Health from then on. Only a
 * signed-in admin's menu can say Health: a visitor's always says Setup.
 */
type Place = { href: string; label: string; icon: IconName };
// The admin web's first page. The other places are under it.
const HOME = "/admin";
const SETUP: Place = { href: HOME, label: "Setup", icon: "setup" };
const PEERS: Place = { href: "/admin/peers", label: "Peers", icon: "network" };
const SESSIONS: Place = {
  href: "/admin/sessions",
  label: "Sessions",
  icon: "bolt",
};
const PROBLEMS: Place = {
  href: "/admin/problems",
  label: "Problems",
  icon: "flag",
};
const PAYMENTS: Place = {
  href: "/admin/payments",
  label: "Payments",
  icon: "wallet",
};
const RECON: Place = {
  href: "/admin/reconciliation",
  label: "Reconciliation",
  icon: "scale",
};
const DRIVERS: Place = {
  href: "/admin/drivers",
  label: "Drivers",
  icon: "user",
};
const TOKENS: Place = { href: "/admin/tokens", label: "Tokens", icon: "card" };
const ACCOUNT: Place = {
  href: "/admin/sign-in",
  label: "Account",
  icon: "out",
};

const RAIL: (Place | { group: string })[] = [
  SETUP,
  { group: "Network" },
  PEERS,
  { group: "Charging" },
  SESSIONS,
  PROBLEMS,
  { group: "Money" },
  PAYMENTS,
  RECON,
  { group: "People" },
  DRIVERS,
  TOKENS,
  { group: "Account" },
  ACCOUNT,
];
const MORE = [PROBLEMS, RECON, DRIVERS, TOKENS, ACCOUNT];

const isAt = (path: string, href: string) =>
  href === HOME ? path === HOME : path === href || path.startsWith(`${href}/`);

function Logo({ name }: { name: string }) {
  return (
    <Link className="logo" href={HOME}>
      <Mark />
      <span className="word">{name.toLowerCase()}</span>
      <span className="role">Admin</span>
    </Link>
  );
}

/** Who is signed in, as a link to the account page; "Sign in" when nobody is. */
function Who() {
  const { admin, hasSecret, signedIn } = useAdmin();
  if (!signedIn)
    return (
      <Link className="who out" href="/admin/sign-in">
        Sign in
      </Link>
    );
  const name = admin ? admin.email : "Admin secret";
  return (
    <Link className="who" href="/admin/sign-in">
      <span className="av" aria-hidden="true">
        {admin ? name.slice(0, 1).toUpperCase() : <Icon name="lock" />}
      </span>
      <span className="em">{name}</span>
      <span className="sr">
        {admin
          ? admin.role === "admin"
            ? ", admin. Account"
            : ", read only. Account"
          : hasSecret
            ? " session. Account"
            : ". Account"}
      </span>
    </Link>
  );
}

export function Shell({
  name,
  children,
}: {
  /** The brand's name, for the logo. */
  name: string;
  children: ReactNode;
}) {
  const path = usePathname();
  const { health } = useSetup();
  const first = health ? "Health" : SETUP.label;
  const current = (href: string) =>
    isAt(path, href) ? ("page" as const) : undefined;
  const money = isAt(path, PAYMENTS.href) || isAt(path, RECON.href);
  const more = MORE.some((p) => isAt(path, p.href));
  const tab = (p: Place, label = p.label, on = current(p.href)) => (
    <Link href={p.href} aria-current={on}>
      <span className="ic">
        <Icon name={p.icon} />
      </span>
      {label}
    </Link>
  );
  return (
    <div className="app">
      <header className="topbar">
        <Logo name={name} />
        <Who />
      </header>
      <div className="rail">
        <Logo name={name} />
        <nav aria-label="Admin">
          {RAIL.map((n) =>
            "group" in n ? (
              <p className="group" key={n.group}>
                {n.group}
              </p>
            ) : (
              <Link key={n.href} href={n.href} aria-current={current(n.href)}>
                <Icon name={n.icon} />
                {n === SETUP ? first : n.label}
              </Link>
            ),
          )}
        </nav>
        <div className="foot">
          <Who />
        </div>
      </div>
      <main id="main" tabIndex={-1}>
        <div className="page">{children}</div>
      </main>
      <nav className="tabs" aria-label="Admin, phone">
        {tab(SETUP, first)}
        {tab(PEERS)}
        {tab(SESSIONS)}
        {tab(PAYMENTS, "Money", money ? "page" : undefined)}
        {/* Remounted on every page, so the sheet closes when a link in it is followed. */}
        <details key={path}>
          <summary aria-current={more ? "page" : undefined}>
            <span className="ic">
              <Icon name="more" />
            </span>
            More
          </summary>
          <div className="more-sheet">
            {MORE.map((p) => (
              <Link key={p.href} href={p.href} aria-current={current(p.href)}>
                <Icon name={p.icon} />
                {p === ACCOUNT ? "Account and sign out" : p.label}
              </Link>
            ))}
          </div>
        </details>
      </nav>
    </div>
  );
}
