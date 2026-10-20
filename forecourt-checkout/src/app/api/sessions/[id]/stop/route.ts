import { NextResponse } from "next/server";
import { isGuestOf } from "@/lib/server/auth";
import { stop } from "@/lib/server/driver";
import { errorResponse, sameOrigin } from "@/lib/server/http";
import { settings } from "@/lib/server/services";
import { UserError } from "@/lib/server/sessions";
import { isDemoId } from "@/lib/demo";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOrigin(request))
      throw new UserError(403, "forbidden", "Cross-site request refused.");
    const { id } = await params;
    const s = settings();
    if (!isDemoId(id) && !(await isGuestOf(s, id)))
      throw new UserError(
        403,
        "not_your_session",
        "Stop charging from the phone you paid with, or use the stop button on the charger.",
      );
    return NextResponse.json(await stop(id, s), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
