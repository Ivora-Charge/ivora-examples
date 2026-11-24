import { NextResponse, type NextRequest } from "next/server";
import { isMalformedOcpiPath } from "@/lib/ocpi/malformed-path";
import { ocpiRequestIds } from "@/lib/ocpi/request-ids";
import { ocpiTimestamp, STATUS } from "@/lib/ocpi/types";

/**
 * A malformed path under /ocpi is a plain 404 in the OCPI envelope, with the same
 * headers as every other OCPI answer, not an error from the router.
 */
export function proxy(request: NextRequest) {
  if (!isMalformedOcpiPath(request.nextUrl.pathname))
    return NextResponse.next();
  const ids = ocpiRequestIds(request.headers);
  return NextResponse.json(
    {
      status_code: STATUS.INVALID_PARAMETERS,
      status_message: "Not found",
      timestamp: ocpiTimestamp(),
    },
    {
      status: 404,
      headers: {
        "X-Request-ID": ids.requestId,
        "X-Correlation-ID": ids.correlationId,
        "Cache-Control": "no-store",
      },
    },
  );
}

export const config = { matcher: "/ocpi/:path*" };
