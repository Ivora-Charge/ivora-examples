import { NextResponse } from "next/server";
import {
  loginAllowed,
  OPERATOR_COOKIE,
  operatorCookie,
  operatorToken,
} from "@/lib/server/auth";
import { sameOrigin } from "@/lib/server/http";
import { operatorPassword, settings } from "@/lib/server/services";
import { passwordMatches } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const back = (query: string) =>
    NextResponse.redirect(new URL(`/operator/login${query}`, request.url), 303);
  if (!sameOrigin(request)) return back("?error=forbidden");
  const s = settings();
  const expected = operatorPassword(s);
  if (!expected) return back("?error=not_configured");
  const client =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!loginAllowed(client)) return back("?error=too_many_attempts");
  const form = await request.formData();
  if (!passwordMatches(String(form.get("password") ?? ""), expected))
    return back("?error=wrong_password");
  const response = NextResponse.redirect(
    new URL("/operator", request.url),
    303,
  );
  response.cookies.set(OPERATOR_COOKIE, operatorToken(s), operatorCookie(s));
  return response;
}
