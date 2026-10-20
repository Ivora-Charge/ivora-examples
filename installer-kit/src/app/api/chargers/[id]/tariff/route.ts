import { NextResponse } from "next/server";
import { body, guarded, type IdContext } from "@/lib/server/route";
import { setTariff } from "@/lib/server/service";

/** Record the per-kWh price for the report (not sent to Ivora). */
export const POST = guarded({ write: true }, async (req, ctx: IdContext) =>
  NextResponse.json(await setTariff((await ctx.params).id, await body(req))),
);
