import { NextResponse } from "next/server";
import { sessionView } from "@/lib/server/driver";
import { errorResponse } from "@/lib/server/http";
import { settings } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The driver's page polls this. Each call also moves the session forward. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const view = await sessionView(id, settings());
    return NextResponse.json(view, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
