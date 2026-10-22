import { guard } from "@/lib/auth";
import { now, report } from "@/lib/depot";
import { reportToCsv } from "@/lib/reports";
import { depotOf } from "@/lib/demo-visitor";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = guard(req, { write: false });
  if (denied) return denied;
  // Demo: the visitor's own depot (lib/demo-visitor.ts).
  const { d } = await depotOf(req);
  const q = new URL(req.url).searchParams;
  const month = q.get("month") ?? now(d).toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
  const by = q.get("by") === "driver" ? "driver" : "vehicle";
  const rows = await report(d, month, by);
  if (q.get("format") === "csv") {
    return new Response(reportToCsv(rows, d.settings.currency), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="depot-${by}-${month}.csv"`,
      },
    });
  }
  return Response.json({ month, by, currency: d.settings.currency, rows });
}
