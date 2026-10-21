import { NextResponse } from "next/server";
import { posPay } from "@/lib/server/cashier";
import { errorResponse } from "@/lib/server/http";
import {
  bearerMatches,
  clientOf,
  markPaidInput,
  RateLimiter,
} from "@/lib/server/pos";
import { posApiSecret, settings } from "@/lib/server/services";
import { UserError } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Counted before the token is checked, so it also brakes guessing.
const limiter = new RateLimiter(30);

/**
 * A convenience-store POS took the payment. Same effect as "Mark paid" on the
 * console. Idempotent by sale ID; see posMarkPaid() for the rules.
 */
export async function POST(request: Request) {
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
    const input = markPaidInput.parse(await request.json().catch(() => null));
    const result = await posPay(input, s);
    console.info("[forecourt] pos mark-paid", { sale: input.sale_id });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
