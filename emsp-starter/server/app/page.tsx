import type { Metadata } from "next";
import { brand } from "@/brand";
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
 * only (names, never values) and nothing from the database, exactly as the overview
 * it replaces did; stops whose state needs a new server read say "cannot check from
 * here" and show their fix. The first admin and first peer stops are filled in by the
 * page itself once an admin is signed in.
 */
export default function SetupPage() {
  const status = getStatus();
  const missing = missingForLive();
  const errors = configErrors();
  const required: readonly string[] = LIVE_REQUIRED;
  const baseSet = !missing.includes("PUBLIC_BASE_URL");
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
    baseUrl: baseSet ? config.publicBaseUrl : null,
    stripeKey: config.stripeSecretKey !== undefined,
    webhookSecret: config.stripeWebhookSecret !== undefined,
    cronSecret: config.cronSecret !== undefined,
    holds: Object.entries(config.holdAmounts).map(([currency, minor]) =>
      formatMinorAmount(minor, currency),
    ),
    codesPerHour: SIGN_IN_LIMITS.code.perEmail.limit,
  };
  return <Setup facts={facts} />;
}
