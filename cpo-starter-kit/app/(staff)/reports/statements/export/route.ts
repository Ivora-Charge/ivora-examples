import { checkNetworkReader, currentStaff } from "@/lib/server/auth";
import {
  getNetwork,
  loadStatement,
  NetworkError,
  statementFileName,
} from "@/lib/server/network";
import { statementCsv } from "@/lib/statement";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });

/**
 * GET /reports/statements/export?host=<id>&month=YYYY-MM: one host's monthly statement
 * as CSV. Operator staff (viewers and above) for any host; a host user for their own
 * host only (any other host is 404). The columns are in the README.
 */
export async function GET(request: Request) {
  let staff;
  try {
    staff = checkNetworkReader(await currentStaff());
  } catch {
    return text("This needs the Viewer role or higher.", 403);
  }
  if (!staff) return text("Sign in first.", 401);
  const params = new URL(request.url).searchParams;
  let view;
  try {
    view = await loadStatement(
      getNetwork(),
      staff,
      params.get("host") ?? undefined,
      params.get("month") ?? undefined,
    );
  } catch (e) {
    if (e instanceof NetworkError)
      return text(e.message, e.code === "not_found" ? 404 : 422);
    console.error("cpo-starter-kit: statement export failed", {
      error: e instanceof Error ? e.name : "error",
    });
    return text("The statement could not be read. Try again.", 502);
  }
  return new Response(statementCsv(view.statement), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${statementFileName(view)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
