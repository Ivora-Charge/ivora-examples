import type { Metadata } from "next";
import { brand } from "@/brand";
import { requestAdmin } from "./admin/ui/current-admin";
import { SIGN_IN_LIMITS } from "@/lib/accounts/sign-in";
import { formatMinorAmount } from "@/lib/locations/pricing";
import {
  config,
  configErrors,
  LIVE_REQUIRED,
  missingForLive,
} from "@/lib/server/config";
import { getStatus } from "@/lib/server/status";
import { Setup, type SetupFacts } from "./setup";

// The root page is outside the layout's title template.
export const metadata: Metadata = {
  title: { absolute: `Setup · ${brand.name}` },
};

/**
 * Setup: the six stops, with what the server knows today. It reads the environment
 * only (names, never values) and nothing from the database; stops whose state needs a
 * new server read say "cannot check from here" and show their fix.
 *
 * A visitor who is not signed in sees the sign-in prompt only (setup.tsx). The page's
 * data for them is what the public overview it replaces always showed (the mode, the
 * OCPI identity, the names of unset or malformed live-mode settings), and nothing
 * else: whether the payment and job secrets are set, the address and the holds are
 * read only for an admin signed in by email.
 */
export default async function SetupPage() {
  const status = getStatus();
  const missing = missingForLive();
  const errors = configErrors();
  const required: readonly string[] = LIVE_REQUIRED;
  const admin = await requestAdmin();
  const facts: SetupFacts = {
    demo: status.mode === "demo",
    required: required.length,
    missing,
    errors,
    // A malformed live-mode setting is not "present and well formed" either.
    malformed: required.filter((name) =>
      errors.some((e) => e.startsWith(`${name} `)),
    ).length,
    version: status.ocpi.version,
    party: `${status.ocpi.country_code}-${status.ocpi.party_id}`,
    codesPerHour: SIGN_IN_LIMITS.code.perEmail.limit,
    settings: admin
      ? {
          baseUrl: missing.includes("PUBLIC_BASE_URL")
            ? null
            : config.publicBaseUrl,
          // Whether each is set, never its value.
          stripeKey: config.stripeSecretKey !== undefined,
          webhookSecret: config.stripeWebhookSecret !== undefined,
          cronSecret: config.cronSecret !== undefined,
          holds: Object.entries(config.holdAmounts).map(([currency, minor]) =>
            formatMinorAmount(minor, currency),
          ),
        }
      : null,
  };
  return <Setup facts={facts} />;
}
