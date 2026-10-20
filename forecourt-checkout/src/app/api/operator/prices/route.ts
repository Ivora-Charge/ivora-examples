import { NextResponse } from "next/server";
import { z } from "zod";
import { isOperator } from "@/lib/server/auth";
import { sameOrigin } from "@/lib/server/http";
import { IvoraError } from "@/lib/server/ivora";
import { savePrices } from "@/lib/server/operator";
import { settings } from "@/lib/server/services";
import { MAX_HOLD_CENTS, MIN_HOLD_CENTS } from "@/lib/settings";

export const dynamic = "force-dynamic";

const cents = z.coerce.number().int().min(0).max(1_000_000);
const form = z.object({
  tariffId: z.coerce.number().int().positive(),
  energyCentsPerKwh: cents,
  timeCentsPerMinute: cents,
  idleCentsPerMinute: cents,
  sessionFeeCents: cents,
  holdCents: z.coerce.number().int().min(MIN_HOLD_CENTS).max(MAX_HOLD_CENTS),
});

export async function POST(request: Request) {
  const back = (query: string) =>
    NextResponse.redirect(
      new URL(`/operator/prices${query}`, request.url),
      303,
    );
  if (!sameOrigin(request)) return back("?error=forbidden");
  const s = settings();
  if (!(await isOperator(s)))
    return NextResponse.redirect(new URL("/operator/login", request.url), 303);
  const parsed = form.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return back("?error=invalid_prices");
  const { tariffId, ...prices } = parsed.data;
  try {
    const result = await savePrices(s, tariffId, prices);
    return back(result.saved ? "?saved=1" : "?demo=1");
  } catch (error) {
    const code = error instanceof IvoraError ? error.code : "invalid_prices";
    return back(`?error=${encodeURIComponent(code)}`);
  }
}
