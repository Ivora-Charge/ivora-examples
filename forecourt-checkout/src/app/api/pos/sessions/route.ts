import { NextResponse } from "next/server";
import { POS_STATUSES, type PosStatus } from "@/lib/pos";
import { POS_LIST_LIMIT, posList } from "@/lib/server/cashier";
import { errorResponse } from "@/lib/server/http";
import { bearerMatches, clientOf, RateLimiter } from "@/lib/server/pos";
import { posApiSecret, settings } from "@/lib/server/services";
import { UserError } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const limiter = new RateLimiter(60);

/** Read-only list of recent in-store sales for a POS: ?status=due|charging|paid. */
export async function GET(request: Request) {
  try {
    if (!limiter.allow(clientOf(request)))
      throw new UserError(
        429,
        "rate_limited",
        "Too many requests. Wait a minute.",
      );
    const s = settings();
    const secret = posApiSecret(s);
    if (!s.payInStore || !secret)
      throw new UserError(
        404,
        "pos_not_configured",
        "The POS endpoints are off. Set CASHIER_PASSWORD and POS_API_SECRET.",
      );
    if (!bearerMatches(request.headers.get("authorization"), secret))
      throw new UserError(
        401,
        "unauthorized",
        "Send Authorization: Bearer <POS_API_SECRET>.",
      );
    const params = new URL(request.url).searchParams;
    const status = params.get("status") ?? "due";
    if (!POS_STATUSES.includes(status as PosStatus))
      throw new UserError(
        400,
        "invalid_status",
        "status must be due, charging or paid.",
      );
    const raw = params.get("limit") ?? "20";
    const limit = /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
    if (limit < 1 || limit > POS_LIST_LIMIT)
      throw new UserError(
        400,
        "invalid_limit",
        `limit must be 1 to ${POS_LIST_LIMIT}.`,
      );
    const data = await posList(status as PosStatus, limit, s);
    return NextResponse.json(
      { status, data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
