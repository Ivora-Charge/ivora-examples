import { NextResponse } from "next/server";
import { qrSvg } from "@/lib/qr";
import { guarded, type IdContext } from "@/lib/server/route";
import { rotatePassword } from "@/lib/server/service";

/** Set a new connection password; returned once, in this response only. */
export const POST = guarded({ write: true }, async (_req, ctx: IdContext) => {
  const result = await rotatePassword((await ctx.params).id);
  return NextResponse.json(
    {
      ...result,
      qr: {
        url: await qrSvg(result.charger.connectionUrl),
        password: await qrSvg(result.password),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
