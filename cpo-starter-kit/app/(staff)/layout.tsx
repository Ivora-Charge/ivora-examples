import type { ReactNode } from "react";
import { config } from "@/lib/server/env";
import { currentStaff } from "@/lib/server/auth";
import { modulesFor } from "@/lib/modules";
import { ROLE_LABELS } from "@/lib/roles";
import { brandThemeCss } from "@/lib/brand-colors";
import { getOnboarding } from "@/lib/server/onboarding";
import type { Staff } from "@/lib/server/team";
import { brand } from "@/brand/brand";
import { Logo } from "@/brand/Logo";
import { signOutAction } from "./auth-actions";
import { stopViewingAsHostAction } from "./hosts/actions";
import Nav from "./nav";
import ThemeToggle from "../theme-toggle";
import ShellBreadcrumbs from "../ui/shell-breadcrumbs";

async function signedInStaff() {
  try {
    return await currentStaff();
  } catch (e) {
    // A setup problem (keys, migrations) must not take down the sign-in page.
    console.error("cpo-starter-kit: session check failed:", {
      error: e instanceof Error ? e.name : "error",
    });
    return null;
  }
}

/**
 * The operator's brand colour as the kit's primary colour, in each mode where it keeps
 * text readable (see lib/brand-colors.ts). Null keeps the kit's own colours.
 */
async function brandCss(staff: Staff | null) {
  // A host user's view keeps the operator's brand too.
  if (!staff) return null;
  try {
    const p = await getOnboarding().store.load(staff.operatorId);
    return brandThemeCss(p.primaryColor);
  } catch (e) {
    console.error("cpo-starter-kit: brand theme failed:", {
      error: e instanceof Error ? e.name : "error",
    });
    return null;
  }
}

/** The staff app: a sidebar (a menu on phones) when signed in, a slim bar when not. */
export default async function StaffLayout({
  children,
}: {
  children: ReactNode;
}) {
  const staff = await signedInStaff();
  const themeCss = await brandCss(staff);
  const sections = staff
    ? modulesFor(staff, { fleet: config.fleetModule })
    : [];
  return (
    <div className={staff ? "shell" : "shell signed-out"}>
      {/* Built only from a validated #rrggbb colour; React hoists it into <head>. */}
      {themeCss && (
        <style href="brand-theme" precedence="high">
          {themeCss}
        </style>
      )}
      <header className="topbar">
        <a className="brand" href="/" aria-label={`${brand.name}, home`}>
          <Logo />
          <span>{brand.name}</span>
        </a>
        {!staff && <ThemeToggle />}
        {staff && (
          <>
            <p className="workspace">
              <span>Workspace</span>
              {config.operatorName}
              {staff.host && (
                <span className="workspace-host">{staff.host.name}</span>
              )}
            </p>
            <Nav
              items={sections.map(({ slug, href, label, status }) => ({
                slug,
                href,
                label,
                soon: status === "coming-soon",
              }))}
              account={
                <div className="who">
                  <span>
                    {staff.email} · {ROLE_LABELS[staff.role]}
                  </span>
                  {staff.demo && staff.host ? (
                    <form action={stopViewingAsHostAction}>
                      <button type="submit" className="button secondary">
                        Back to the demo owner
                      </button>
                    </form>
                  ) : staff.demo ? (
                    <span className="badge">Sample</span>
                  ) : (
                    <form action={signOutAction}>
                      <button type="submit" className="button secondary">
                        Sign out
                      </button>
                    </form>
                  )}
                  <ThemeToggle />
                </div>
              }
            />
          </>
        )}
      </header>
      <main id="main" tabIndex={-1}>
        <div className="page">
          {staff?.demo && staff.host && (
            <p className="notice view-as" role="note">
              Demo: you are viewing the app as a user of {staff.host.name}. They
              see only its sites, and change only what the operator switched on.
            </p>
          )}
          {staff ? (
            <ShellBreadcrumbs
              sections={sections.map(({ href, label }) => ({ href, label }))}
            >
              {children}
            </ShellBreadcrumbs>
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  );
}
