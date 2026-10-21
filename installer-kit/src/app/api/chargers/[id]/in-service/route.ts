import { NextResponse } from "next/server";
import { guarded, type IdContext } from "@/lib/server/route";
import { markInService } from "@/lib/server/service";

/** Record that the charger is in service; test sessions are refused after it. */
export const POST = guarded({ write: true }, async (_req, ctx: IdContext) =>
  NextResponse.json(markInService((await ctx.params).id)),
);
