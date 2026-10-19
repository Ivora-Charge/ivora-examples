import { NextResponse } from "next/server";
import { refresh } from "@/lib/service";
import { fail } from "@/lib/http";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const c = await refresh((await ctx.params).id);
    return c
      ? NextResponse.json(c)
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    return fail(e);
  }
}
