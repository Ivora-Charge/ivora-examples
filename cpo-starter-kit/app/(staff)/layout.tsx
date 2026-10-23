import type { ReactNode } from "react";
import { config, isDemo } from "@/lib/server/env";
import { currentStaff } from "@/lib/server/auth";
import { visibleModules } from "@/lib/modules";
import { ROLE_LABELS } from "@/lib/roles";
import { brandThemeCss } from "@/lib/brand-colors";
import { getOnboarding } from "@/lib/server/onboarding";
import type { Staff } from "@/lib/server/team";
import { brand } from "@/brand/brand";
import { Logo } from "@/brand/Logo";
import { signOutAction } from "./auth-actions";
import Nav from "./nav";
import ThemeToggle from "../theme-toggle";

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
              {isDemo() && <span>Placeholder brand: replace it in brand/</span>}
            </p>
            <Nav
              items={visibleModules({ fleet: config.fleetModule }).map(
                ({ slug, href, label, status }) => ({
                  slug,
                  href,
                  label,
                  soon: status === "coming-soon",
                }),
              )}
            />
            <div className="who">
              <span>
                {staff.email} · {ROLE_LABELS[staff.role]}
              </span>
              {staff.demo ? (
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
          </>
        )}
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
