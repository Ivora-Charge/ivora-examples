import { NextResponse } from "next/server";
import { testCharger } from "@/lib/service";
import { fail } from "@/lib/http";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const c = await testCharger((await ctx.params).id);
    return c
      ? NextResponse.json(c)
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}
