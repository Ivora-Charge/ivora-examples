import { NextResponse } from "next/server";
import { reportPdf } from "@/lib/pdf";
import { db } from "@/lib/store";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const c = db().chargers.get((await ctx.params).id);
  const site = c && db().sites.get(c.siteId);
  if (!c || !site)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  const pdf = await reportPdf({ charger: c, site });
  return new Response(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf" },
  });
}
