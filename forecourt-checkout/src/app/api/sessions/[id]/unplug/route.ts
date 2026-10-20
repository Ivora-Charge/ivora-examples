import { NextResponse } from "next/server";
import { unplug } from "@/lib/server/driver";
import { errorResponse, sameOrigin } from "@/lib/server/http";
import { settings } from "@/lib/server/services";
import { UserError } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/** Demo only: in live mode the charger reports the unplug and the transaction ends. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOrigin(request))
      throw new UserError(403, "forbidden", "Cross-site request refused.");
    const { id } = await params;
    return NextResponse.json(await unplug(id, settings()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
