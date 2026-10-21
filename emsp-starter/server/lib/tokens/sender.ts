import "server-only";
import { OcpiProblem } from "@/lib/ocpi/errors";
import { dateTimeMs } from "@/lib/ocpi/locations";
import { ocpiResponse, type OcpiContext } from "@/lib/ocpi/server";
import { sameParty, STATUS } from "@/lib/ocpi/types";
import { ocpiUrls } from "@/lib/server/config";
import { toOcpiToken } from "./push";
import { tokenStore } from "./registry";

/**
 * Our Tokens Sender interface (OCPI 2.2.1 section 12.2.1.1): a CPO pulls every token
 * we issued, page by page, oldest last_updated first.
 *
 *   GET /ocpi/2.2.1/tokens[?date_from=][&date_to=][&offset=][&limit=]
 *
 * date_from is inclusive and date_to exclusive, on last_updated. Pages carry
 * X-Total-Count, X-Limit and, when there are more, a Link to the next page.
 */

/** Most tokens per page (X-Limit). */
export const TOKENS_PAGE_LIMIT = 100;

const invalid = (message: string) =>
  new OcpiProblem(400, STATUS.INVALID_PARAMETERS, message);

const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/;

function dateParam(q: URLSearchParams, name: string): string | undefined {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  if (!DATE_TIME.test(v) || Number.isNaN(dateTimeMs(v)))
    throw invalid(`${name} must be a DateTime`);
  return new Date(dateTimeMs(v)).toISOString();
}

function intParam(
  q: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
): number {
  const v = q.get(name);
  if (v === null || v === "") return fallback;
  if (!/^\d{1,9}$/.test(v) || Number(v) < min)
    throw invalid(`${name} must be a whole number of at least ${min}`);
  return Number(v);
}

/**
 * Our tokens are for CPOs: the request must come from one of the peer's CPO parties
 * (OCPI-from). withOcpi has already checked it is one of the peer's parties.
 */
export function requireCpoParty(ctx: OcpiContext) {
  const from = ctx.from;
  if (
    !from ||
    !ctx.peer.roles.some(
      (r) =>
        r.role === "CPO" &&
        sameParty({ countryCode: r.country_code, partyId: r.party_id }, from),
    )
  )
    throw new OcpiProblem(
      403,
      STATUS.CLIENT_ERROR,
      "Tokens are served to CPO parties only",
    );
}

/** GET /ocpi/2.2.1/tokens */
export async function tokensSender(ctx: OcpiContext): Promise<Response> {
  if (ctx.request.method !== "GET")
    throw new OcpiProblem(405, STATUS.CLIENT_ERROR, "Method not allowed");
  requireCpoParty(ctx);
  const q = new URL(ctx.request.url).searchParams;
  const dateFrom = dateParam(q, "date_from");
  const dateTo = dateParam(q, "date_to");
  const offset = intParam(q, "offset", 0, 0);
  const limit = Math.min(
    TOKENS_PAGE_LIMIT,
    intParam(q, "limit", TOKENS_PAGE_LIMIT, 1),
  );

  const { tokens, total } = await tokenStore().page({
    dateFrom,
    dateTo,
    offset,
    limit,
  });
  const now = new Date();
  const res = ocpiResponse(
    tokens.map((t) => toOcpiToken(t, now)),
    ctx,
  );
  res.headers.set("X-Total-Count", String(total));
  res.headers.set("X-Limit", String(TOKENS_PAGE_LIMIT));
  if (offset + tokens.length < total && tokens.length > 0) {
    const next = new URL(ocpiUrls().tokens);
    next.searchParams.set("offset", String(offset + tokens.length));
    next.searchParams.set("limit", String(limit));
    if (q.get("date_from"))
      next.searchParams.set("date_from", q.get("date_from")!);
    if (q.get("date_to")) next.searchParams.set("date_to", q.get("date_to")!);
    res.headers.set("Link", `<${next.href}>; rel="next"`);
  }
  return res;
}
