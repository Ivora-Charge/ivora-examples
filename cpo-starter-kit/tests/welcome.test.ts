import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The landing page and the root layout around it, rendered as a signed-out visitor
// sees them. They must read no session and no operator data beyond the public
// operator name: the session and onboarding modules throw if anything calls them.
let demo = false;

vi.mock("@/lib/server/env", () => ({
  isDemo: () => demo,
  config: { operatorName: "Harbour Charging Co", fleetModule: false },
}));
const touched = vi.fn();
vi.mock("@/lib/server/auth", () => ({
  currentStaff: () => touched("currentStaff"),
  requireRole: () => touched("requireRole"),
}));
vi.mock("@/lib/server/onboarding", () => ({
  getOnboarding: () => touched("getOnboarding"),
}));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "font" }) }));
vi.mock("next/link", () => ({
  default: ({ href, ...p }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...p }),
}));
vi.mock("@/brand/tokens.css", () => ({}));
vi.mock("@/app/globals.css", () => ({}));

const { default: Welcome } = await import("@/app/welcome/page");
const { default: RootLayout } = await import("@/app/layout");

function render() {
  return renderToStaticMarkup(
    createElement(RootLayout, { children: createElement(Welcome) }),
  );
}

beforeEach(() => {
  demo = false;
  touched.mockClear();
});

describe("/welcome", () => {
  it("live mode: asks staff to sign in and reads no session or operator data", () => {
    const html = render();
    expect(html).toContain('href="/login"');
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Try the demo");
    expect(html).not.toContain("Demo mode");
    expect(html).toContain("Harbour Charging Co");
    // No staff shell: no sidebar, workspace chip or signed-in user.
    expect(html).not.toContain('aria-label="Main"');
    expect(html).not.toContain("Workspace</span>");
    expect(touched).not.toHaveBeenCalled();
  });

  it("demo mode: offers the demo and keeps the Demo banner", () => {
    demo = true;
    const html = render();
    expect(html).toContain("Try the demo");
    expect(html).not.toContain('href="/login"');
    expect(html).toContain("Demo mode:");
    expect(touched).not.toHaveBeenCalled();
  });

  it("lists only the modules turned on", () => {
    expect(render()).not.toContain("RFID cards");
  });
});
