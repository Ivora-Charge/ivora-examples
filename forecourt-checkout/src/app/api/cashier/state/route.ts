import { NextResponse } from "next/server";
import { cashierConsole } from "@/lib/server/cashier";
import { errorResponse } from "@/lib/server/http";
import { cashierRequest, noStore } from "@/lib/server/cashier-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The console polls this. Each call also moves active sales forward. */
export async function GET(request: Request) {
  try {
    const s = await cashierRequest(request);
    return NextResponse.json(await cashierConsole(s), noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
