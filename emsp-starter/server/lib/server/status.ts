import "server-only";
import { brand } from "@/brand";
import { publicSummary } from "./config";
import { databaseReady } from "@/lib/setup/status";
import { mode, type Mode } from "./demo";

/**
 * Body of `GET /api/v1/status`, read by the driver app. Contains no secrets.
 *
 * `mode` is "demo", "live", or "setup": out of demo mode, but the database does not
 * have every migration this build ships (or does not answer), so the server is not
 * live yet. "live" is only said when the database check passes.
 */
export type Status = {
  mode: Mode | "setup";
  name: string;
  ocpi: { version: string; country_code: string; party_id: string };
};

/**
 * The status as the environment alone tells it: "live" here means "not in demo mode".
 * For the pages' own use (the OCPI identity, the demo flag); the public API answers
 * with `publicStatus`.
 */
export function getStatus(): Status & { mode: Mode } {
  const s = publicSummary();
  return {
    mode: mode(),
    name: brand.name,
    ocpi: {
      version: s.ocpiVersion,
      country_code: s.countryCode,
      party_id: s.partyId,
    },
  };
}

/** The answer of `GET /api/v1/status`: "live" only when the database check passes. */
export async function publicStatus(
  ready: () => Promise<boolean> = databaseReady,
): Promise<Status> {
  const status = getStatus();
  if (status.mode === "live" && !(await ready()))
    return { ...status, mode: "setup" };
  return status;
}
