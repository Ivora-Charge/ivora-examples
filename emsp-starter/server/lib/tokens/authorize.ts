import "server-only";
import { randomUUID } from "node:crypto";
import { accountStore } from "@/lib/accounts/registry";
import type { AccountStore } from "@/lib/accounts/store";
import { OcpiProblem } from "@/lib/ocpi/errors";
import { ocpiResponse, readJson, type OcpiContext } from "@/lib/ocpi/server";
import {
  isTokenType,
  parseLocationReferences,
  type AllowedType,
  type AuthorizationInfo,
  type LocationReferences,
} from "@/lib/ocpi/token-objects";
import { STATUS } from "@/lib/ocpi/types";
import type { DisplayText } from "@/lib/ocpi/locations";
import { toOcpiToken } from "./push";
import { tokenStore } from "./registry";
import { requireCpoParty } from "./sender";
import type { DriverToken } from "./store";

/**
 * Real-time authorization (OCPI 2.2.1 section 12.2.1.2): a CPO asks whether a driver
 * may charge, before it starts a session.
 *
 *   POST /ocpi/2.2.1/tokens/{token_uid}/authorize[?type={type}]
 *   body: optional LocationReferences (location_id, evse_uids)
 *
 * Answers an AuthorizationInfo: ALLOWED (with an authorization_reference the CPO puts
 * on the session and CDR), BLOCKED, EXPIRED, NO_CREDIT or NOT_ALLOWED. An unknown token
 * gets 2004 (HTTP 404); an invalid body 2001. Every answer is written to the audit log.
 */

/**
 * The driver behind a token, as far as charging goes: a restricted account may not
 * charge (NOT_ALLOWED), and an account without a default card has no credit
 * (NO_CREDIT). A token of a driver reference with no account (one an admin created
 * before driver sign-in) rests on the token's own status.
 */
export type DriverStanding = "ok" | "blocked" | "no_credit" | "not_allowed";

export async function driverStanding(
  token: DriverToken,
  accounts: AccountStore = accountStore(),
): Promise<DriverStanding> {
  const driver = await accounts.getDriver(token.driverRef);
  if (!driver) return "ok";
  if (driver.status !== "active") return "not_allowed";
  return driver.defaultPaymentMethodId ? "ok" : "no_credit";
}

const INFO: Record<Exclude<AllowedType, "ALLOWED">, string> = {
  BLOCKED: "This token is blocked.",
  EXPIRED: "This token has expired.",
  NO_CREDIT: "No usable payment method on this account.",
  NOT_ALLOWED: "This driver may not charge here.",
};

/**
 * The answer for a token. Order: the token's own status (blocked, then expired), then
 * the driver's standing.
 */
export function decide(
  token: DriverToken,
  now: Date,
  standing: DriverStanding = "ok",
): { allowed: AllowedType; info?: DisplayText } {
  let allowed: AllowedType = "ALLOWED";
  if (token.status === "blocked") allowed = "BLOCKED";
  else if (
    token.status === "expired" ||
    (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime())
  )
    allowed = "EXPIRED";
  else if (standing === "blocked") allowed = "BLOCKED";
  else if (standing === "no_credit") allowed = "NO_CREDIT";
  else if (standing === "not_allowed") allowed = "NOT_ALLOWED";
  return allowed === "ALLOWED"
    ? { allowed }
    : { allowed, info: { language: "en", text: INFO[allowed] } };
}

const invalid = (message: string) =>
  new OcpiProblem(400, STATUS.INVALID_PARAMETERS, message);

/** The token uid from /ocpi/2.2.1/tokens/{token_uid}/authorize. */
function uidFromPath(ctx: OcpiContext): string {
  const path = new URL(ctx.request.url).pathname.replace(/\/+$/, "");
  const m = /^\/ocpi\/2\.2\.1\/tokens\/([^/]+)\/authorize$/.exec(path);
  if (!m) throw new OcpiProblem(404, STATUS.CLIENT_ERROR, "Unknown path");
  let uid: string;
  try {
    uid = decodeURIComponent(m[1]);
  } catch {
    throw invalid("Invalid token_uid in the path");
  }
  if (!/^[\x21-\x7e]{1,36}$/.test(uid))
    throw invalid("token_uid must be 1 to 36 printable characters");
  return uid;
}

/** POST /ocpi/2.2.1/tokens/{token_uid}/authorize */
export async function authorizeToken(ctx: OcpiContext): Promise<Response> {
  if (ctx.request.method !== "POST")
    throw new OcpiProblem(405, STATUS.CLIENT_ERROR, "Method not allowed");
  requireCpoParty(ctx);
  const uid = uidFromPath(ctx);
  const type = new URL(ctx.request.url).searchParams.get("type") ?? "RFID";
  if (!isTokenType(type))
    throw invalid("type must be AD_HOC_USER, APP_USER, OTHER or RFID");

  let location: LocationReferences | undefined;
  const raw = await readJson(ctx.request, { optional: true });
  if (raw !== undefined && raw !== null) {
    const parsed = parseLocationReferences(raw);
    if (!parsed.ok)
      throw invalid(
        `Invalid LocationReferences: ${parsed.errors.slice(0, 10).join("; ")}`,
      );
    location = parsed.value;
  }

  // We issue APP_USER and RFID tokens only; uids are stored upper case (CiString).
  const token =
    type === "APP_USER" || type === "RFID"
      ? await tokenStore().getToken(uid.toUpperCase(), type)
      : null;
  if (!token) throw new OcpiProblem(404, STATUS.UNKNOWN_TOKEN, "Unknown token");

  const now = new Date();
  const { allowed, info } = decide(token, now, await driverStanding(token));
  const answer: AuthorizationInfo = {
    allowed,
    token: toOcpiToken(token, now),
  };
  if (allowed === "ALLOWED") {
    answer.authorization_reference = randomUUID();
    // The EVSEs the driver may charge at: all of those asked about.
    if (location) answer.location = location;
  }
  if (info) answer.info = info;

  try {
    await ctx.store.audit({
      actor: `peer:${ctx.peer.id}`,
      action: "token.authorize",
      subjectId: token.id,
      requestId: ctx.requestId,
      details: {
        allowed,
        type: token.type,
        authorization_reference: answer.authorization_reference ?? null,
        location_id: location?.location_id ?? null,
      },
    });
  } catch (e) {
    // The CPO is waiting with a driver at the charger: answer even if the log fails.
    console.error(
      `Audit of a token authorization failed (request ${ctx.requestId}): ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
  return ocpiResponse(answer, ctx);
}
