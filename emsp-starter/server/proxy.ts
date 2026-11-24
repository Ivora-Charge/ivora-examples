import { NextResponse, type NextRequest } from "next/server";
import { isMalformedOcpiPath } from "@/lib/ocpi/malformed-path";

/** A malformed path under /ocpi is a plain 404, not an error from the router. */
export function proxy(request: NextRequest) {
  if (isMalformedOcpiPath(request.nextUrl.pathname))
    return NextResponse.json(
      {
        status_code: 2001,
        status_message: "Not found",
        timestamp: new Date().toISOString(),
      },
      { status: 404 },
    );
  return NextResponse.next();
}

export const config = { matcher: "/ocpi/:path*" };
