import "server-only";
import type { NextRequest } from "next/server";
import { requireOperator } from "./auth";
import { fail } from "./http";

export type IdContext = { params: Promise<{ id: string }> };

/**
 * Wrap an operator route: check the operator session (and same origin for
 * writes) before doing anything, and turn errors into actionable responses.
 */
export function guarded<C>(
  opts: { write: boolean },
  handler: (req: NextRequest, ctx: C) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: C) => {
    try {
      requireOperator(req, opts);
      return await handler(req, ctx);
    } catch (e) {
      return fail(e);
    }
  };
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json().catch(() => null);
  return value && typeof value === "object" ? value : {};
}

/** The origin the browser used, for demo-only sticker URLs. */
export function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
    new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

export function pdfResponse(pdf: Uint8Array, filename: string) {
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
