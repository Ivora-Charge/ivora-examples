import type { Metadata } from "next";
import { brand } from "@/brand";
import { forEmailAdmin } from "./admin/ui/for-admin";
import { SIGN_IN_LIMITS } from "@/lib/accounts/sign-in";
import { formatMinorAmount } from "@/lib/locations/pricing";
import {
  config,
  configErrors,
  LIVE_REQUIRED,
  missingForLive,
} from "@/lib/server/config";
import { getStatus } from "@/lib/server/status";
import { Setup, type SetupFacts, type SetupSettings } from "./setup";

// The root page is outside the layout's title template.
export const metadata: Metadata = {
  title: { absolute: `Setup · ${brand.name}` },
};

/**
 * What the environment says, by name and never by value: which settings are unset or
 * malformed (live-mode and optional ones alike), and whether the payment and job
 * secrets are set. Called for a signed-in admin only.
 */
function readSettings(): SetupSettings {
  const missing = missingForLive();
  const errors = configErrors();
  const required: readonly string[] = LIVE_REQUIRED;
  return {
    missing,
    errors,
    // A malformed live-mode setting is not "present and well formed" either.
    malformed: required.filter((name) =>
      errors.some((e) => e.startsWith(`${name} `)),
    ).length,
    baseUrl: missing.includes("PUBLIC_BASE_URL") ? null : config.publicBaseUrl,
    // Whether each is set, never its value.
    stripeKey: config.stripeSecretKey !== undefined,
    webhookSecret: config.stripeWebhookSecret !== undefined,
    cronSecret: config.cronSecret !== undefined,
    holds: Object.entries(config.holdAmounts).map(([currency, minor]) =>
      formatMinorAmount(minor, currency),
    ),
  };
}

/**
 * Setup: the six stops, with what the server knows today. It reads the environment
 * only (names, never values) and nothing from the database; stops whose state needs a
 * new server read say "cannot check from here" and show their fix.
 *
 * A visitor who is not signed in sees the sign-in prompt only (setup.tsx), and the
 * page's data for them holds nothing about this deployment's configuration: only the
 * mode, which the banner on every page shows, and constants of the code. The
 * settings and the OCPI party are read, and sent, only for an admin signed in by
 * email.
 */
export default async function SetupPage() {
  const status = getStatus();
  const facts: SetupFacts = {
    demo: status.mode === "demo",
    required: LIVE_REQUIRED.length,
    codesPerHour: SIGN_IN_LIMITS.code.perEmail.limit,
    // The OCPI version this code implements: the same on every deployment.
    version: status.ocpi.version,
    party: await forEmailAdmin(
      () => `${status.ocpi.country_code}-${status.ocpi.party_id}`,
    ),
    settings: await forEmailAdmin(readSettings),
  };
  return <Setup facts={facts} />;
}
