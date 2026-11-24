import type { Metadata } from "next";
import { brand } from "@/brand";
import { forEmailAdmin } from "./admin/ui/for-admin";
import { requestAdmin } from "./admin/ui/current-admin";
import { SIGN_IN_LIMITS } from "@/lib/accounts/sign-in";
import { formatMinorAmount } from "@/lib/locations/pricing";
import { config, missingForLive } from "@/lib/server/config";
import { getStatus } from "@/lib/server/status";
import { publicSetupView } from "@/lib/setup/status";
import { Setup, type SetupFacts, type SetupSettings } from "./setup";
import { logText } from "@/lib/server/log-error";

// The root page is outside the layout's title template.
export const metadata: Metadata = {
  title: { absolute: `Setup · ${brand.name}` },
};

/**
 * The two things of the configuration the page's fixes and limits show: this
 * server's address and the hold per charge. Called for an admin signed in by email
 * only.
 */
function readSettings(): SetupSettings {
  return {
    baseUrl: missingForLive().includes("PUBLIC_BASE_URL")
      ? null
      : config.publicBaseUrl,
    holds: Object.entries(config.holdAmounts).map(([currency, minor]) =>
      formatMinorAmount(minor, currency),
    ),
  };
}

/**
 * Setup, called Health once all six checks pass.
 *
 * What the six stops found comes from the setup status read
 * (app/admin/setup/actions.ts), which the page asks for once an admin is signed in;
 * none of it is in what this server component sends.
 *
 * A visitor who is not signed in gets the mode (which the banner on every page shows)
 * and constants of the code. Before the first admin exists, and only then, they also
 * get the six stops' fixed names and whether each passes (`publicSetupView`): no
 * value, address, key, count, time or variable name. Once an admin exists that is
 * gone, and the page is the sign-in prompt alone.
 */
export default async function SetupPage() {
  const status = getStatus();
  const facts: SetupFacts = {
    demo: status.mode === "demo",
    codesPerHour: SIGN_IN_LIMITS.code.perEmail.limit,
    // The OCPI version this code implements: the same on every deployment.
    version: status.ocpi.version,
    party: await forEmailAdmin(
      () => `${status.ocpi.country_code}-${status.ocpi.party_id}`,
    ),
    settings: await forEmailAdmin(readSettings),
    // Not read at all for a signed-in admin, whose page asks for the full status.
    publicView: (await requestAdmin()) ? null : await safePublicView(),
  };
  return <Setup facts={facts} />;
}

/** The public view, or nothing: a failed read shows the sign-in prompt alone. */
async function safePublicView() {
  try {
    return await publicSetupView();
  } catch (e) {
    console.error(`Public setup view failed: ${logText(e)}`);
    return null;
  }
}
