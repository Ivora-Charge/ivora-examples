import { NextResponse } from "next/server";
import { z } from "zod";
import { guestCookie, guestToken, GUEST_COOKIE } from "@/lib/server/auth";
import { pay } from "@/lib/server/driver";
import { errorResponse, sameOrigin } from "@/lib/server/http";
import { settings } from "@/lib/server/services";
import { UserError } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

const input = z.object({
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/),
  connector: z.number().int().min(1).max(99),
  // One key per tap on "Pay": a retry after a timeout reuses it.
  requestId: z.uuid(),
});

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request))
      throw new UserError(403, "forbidden", "Cross-site request refused.");
    const body = input.parse(await request.json());
    const s = settings();
    const { id, url } = await pay(body, s);
    const response = NextResponse.json({ id, url });
    if (!s.demo)
      response.cookies.set(GUEST_COOKIE, guestToken(s, id), guestCookie(s));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
