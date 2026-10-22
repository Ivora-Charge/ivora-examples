import "server-only";
import { OcpiProblem } from "./errors";
import { sameId } from "./locations";
import { readJson, type OcpiContext } from "./server";
import { STATUS } from "./types";

/**
 * Helpers for our Receiver interfaces (locations, tariffs, sessions): the
 * `/{country_code}/{party_id}/{id}[/...]` path after a module's base path, and the
 * checks every push shares.
 */

export const invalid = (message: string) =>
  new OcpiProblem(400, STATUS.INVALID_PARAMETERS, message);
export const notAllowed = () =>
  new OcpiProblem(405, STATUS.CLIENT_ERROR, "Method not allowed");

const SEGMENT = /^[\x21-\x7e]{1,36}$/;

export type ReceiverPath = {
  /** Upper case. */
  countryCode: string;
  partyId: string;
  id: string;
  /** Segments after the ID (an EVSE and connector, for locations). */
  rest: string[];
};

/**
 * The CPO party a push comes from: OCPI-from, which must be a CPO party of the calling
 * peer, and `party` (of the URL or the body) must be that same party. A peer with
 * several CPO parties cannot write one party's objects in the name of another.
 */
export function pushingParty(
  ctx: OcpiContext,
  party: { countryCode: string; partyId: string },
  where: string,
): void {
  const from = ctx.from;
  if (!from)
    throw invalid("Missing or invalid OCPI-from/OCPI-to routing headers");
  const cpo = ctx.peer.roles.some(
    (r) =>
      r.role === "CPO" &&
      sameId(r.country_code, from.countryCode) &&
      sameId(r.party_id, from.partyId),
  );
  if (!cpo)
    throw new OcpiProblem(
      403,
      STATUS.CLIENT_ERROR,
      "OCPI-from-country-code and OCPI-from-party-id are not a CPO party of this token",
    );
  if (
    !sameId(party.countryCode, from.countryCode) ||
    !sameId(party.partyId, from.partyId)
  )
    throw new OcpiProblem(
      403,
      STATUS.CLIENT_ERROR,
      `The country_code and party_id ${where} are not the OCPI-from party`,
    );
}

/**
 * The path segments after `/ocpi/2.2.1/{module}/`, decoded and checked. The country
 * code and party ID must be the CPO party in OCPI-from, one of the calling peer's
 * (pushingParty): a CPO cannot write another CPO's objects.
 */
export function receiverPath(ctx: OcpiContext, module: string): ReceiverPath {
  const path = new URL(ctx.request.url).pathname;
  const base = `/ocpi/2.2.1/${module}/`;
  if (!path.startsWith(base)) throw invalid("Unknown path");
  let parts: string[];
  try {
    parts = path
      .slice(base.length)
      .replace(/\/+$/, "")
      .split("/")
      .map(decodeURIComponent);
  } catch {
    throw invalid("Invalid path");
  }
  if (parts.length < 3 || parts.some((p) => !SEGMENT.test(p)))
    throw invalid(
      "Path must be /{country_code}/{party_id}/{id}, with IDs of 1 to 36 characters",
    );
  const [countryCode, partyId] = parts;
  if (!/^[A-Za-z]{2}$/.test(countryCode) || !/^[A-Za-z0-9]{3}$/.test(partyId))
    throw invalid("Invalid country_code or party_id in the path");
  pushingParty(ctx, { countryCode, partyId }, "in the path");
  return {
    countryCode: countryCode.toUpperCase(),
    partyId: partyId.toUpperCase(),
    id: parts[2],
    rest: parts.slice(3),
  };
}

/** The parsed value, or a 2001 naming the problems. */
export function valid<T>(
  what: string,
  parsed: { ok: true; value: T } | { ok: false; errors: string[] },
): T {
  if (!parsed.ok)
    throw invalid(`Invalid ${what}: ${parsed.errors.slice(0, 10).join("; ")}`);
  return parsed.value;
}

/**
 * The identifying fields of a PUT or PATCH body must match the URL (whose party is the
 * OCPI-from party, receiverPath).
 */
export function checkIds(
  body: Record<string, unknown>,
  ids: Record<string, string>,
) {
  for (const [field, expected] of Object.entries(ids)) {
    const v = body[field];
    if (v !== undefined && (typeof v !== "string" || !sameId(v, expected)))
      throw invalid(`${field} in the body does not match the URL`);
  }
}

export const asObject = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** The request body, read once however many times a retry asks for it. */
export function bodyOnce(ctx: OcpiContext) {
  let body: Promise<unknown> | undefined;
  return () => (body ??= readJson(ctx.request));
}
