import { checkRole, currentStaff } from "@/lib/server/auth";
import { describeError } from "@/lib/server/ivora";
import {
  csvFileName,
  getReports,
  loadReportsContext,
  sessionsCsv,
} from "@/lib/server/reports";

export const dynamic = "force-dynamic";
/** The export reads up to CSV_SCAN (50 pages, 50 seconds) before it ends. */
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
 * GET /reports/export: the Reports page's sessions (same period and filters) as CSV,
 * streamed page by page. Viewers and above; the columns are in the README.
 */
export async function GET(request: Request) {
  let staff;
  try {
    staff = checkRole(await currentStaff(), "viewer");
  } catch {
    return text("This needs the Viewer role or higher.", 403);
  }
  if (!staff) return text("Sign in first.", 401);
  const d = getReports();
  const r = await loadReportsContext(
    d,
    staff,
    new URL(request.url).searchParams,
  );
  if (!r.ok) return text(r.error, 502);
  if (r.context.queryError) return text(r.context.queryError, 400);
  let body: ReadableStream<Uint8Array>;
  try {
    body = await sessionsCsv(d, r.context.query, r.context.scan);
  } catch (e) {
    return text(describeError(e), 502);
  }
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName(r.context.query)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
