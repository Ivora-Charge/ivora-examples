import { checkRole, currentStaff } from "@/lib/server/auth";
import {
  csvFileName,
  getReports,
  loadReportsContext,
  reportFilter,
  sessionsCsv,
} from "@/lib/server/reports";

export const dynamic = "force-dynamic";
/**
 * The export reads only the kit's database and stops at CSV_SECONDS (45), so the
 * download fails visibly rather than running into this limit.
 */
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
 * streamed. Viewers and above; the columns are in the README.
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
  const csv = await sessionsCsv(
    d,
    reportFilter(staff, r.context.query),
    r.context.places,
  );
  if (!csv.ok) return text(csv.error, csv.status);
  return new Response(csv.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName(r.context.query)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
