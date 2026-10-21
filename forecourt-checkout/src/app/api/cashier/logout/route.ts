import { NextResponse } from "next/server";
import { CASHIER_COOKIE } from "@/lib/server/auth";
import { sameOrigin } from "@/lib/server/http";

export async function POST(request: Request) {
  // A cross-site form must not sign the cashier out.
  if (!sameOrigin(request))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const response = NextResponse.redirect(
    new URL("/cashier/login", request.url),
    303,
  );
  response.cookies.delete(CASHIER_COOKIE);
  return response;
}
