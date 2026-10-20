import { NextResponse } from "next/server";
import { guarded, type IdContext } from "@/lib/server/route";
import { refresh } from "@/lib/server/service";

/** Current charger state, read from the API (polled by the wizard). */
export const GET = guarded({ write: false }, async (_req, ctx: IdContext) =>
  NextResponse.json(await refresh((await ctx.params).id)),
);
