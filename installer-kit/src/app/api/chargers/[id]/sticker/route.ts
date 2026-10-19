import { NextResponse } from "next/server";
import { stickerPdf } from "@/lib/pdf";
import { db } from "@/lib/store";
import { assertNotIvoraDomain, qrBase, stickerUrl } from "@/lib/urls";
import { fail } from "@/lib/http";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const c = db().chargers.get((await ctx.params).id);
    const connector = Number(
      new URL(req.url).searchParams.get("connector") ?? "1",
    );
    const label = c?.boot?.connectors.find((k) => k.id === connector)?.label;
    if (!c || !label)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    assertNotIvoraDomain(qrBase());
    const pdf = await stickerPdf({
      url: stickerUrl(c.id, connector),
      siteName: db().sites.get(c.siteId)?.name ?? "",
      connectorLabel: label,
    });
    return new Response(Buffer.from(pdf), {
      headers: { "Content-Type": "application/pdf" },
    });
  } catch (e) {
    return fail(e);
  }
}
