import type { ActionResult } from "../ui/kit";

/**
 * Whether a failed registration was the peer refusing the token we sent (HTTP 401 or
 * 403), from today's answer alone: the OCPI client writes "refused our token (HTTP
 * 401)" into the message, and the code is `HTTP 401` unless the peer also gave an OCPI
 * status. The connect flow then says "get a new one-time token" instead of the general
 * next step of lib/admin/errors.ts, which is written for a registered peer ("rotate
 * tokens").
 */
export function tokenRefused(r: ActionResult): boolean {
  if (r.ok !== false) return false;
  return (
    /^HTTP 40[13]$/.test(r.code ?? "") ||
    /refused our token \(HTTP 40[13]\)/.test(r.message ?? "")
  );
}
