import { NextResponse } from "next/server";
import { cashierConsole } from "@/lib/server/cashier";
import { errorResponse } from "@/lib/server/http";
import { cashierRequest, noStore } from "@/lib/server/cashier-guard";
import { MAX_KNOWN_SALES } from "@/lib/server/store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The console polls this. Each call also moves active sales forward. */
export async function GET(request: Request) {
  try {
    const s = await cashierRequest(request);
    // Sales the console has shown; checked against the sale ID format server-side.
    const known = (new URL(request.url).searchParams.get("sales") ?? "")
      .split(",")
      .filter(Boolean)
      .slice(0, MAX_KNOWN_SALES);
    return NextResponse.json(await cashierConsole(s, known), noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
