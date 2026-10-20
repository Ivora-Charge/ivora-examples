import { NextResponse } from "next/server";
import { HttpError } from "@/lib/server/errors";
import { body, guarded, type IdContext } from "@/lib/server/route";
import { startTest, stopTest } from "@/lib/server/service";

/** Remote start or stop of the commissioning test session. */
export const POST = guarded({ write: true }, async (req, ctx: IdContext) => {
  const id = (await ctx.params).id;
  const { action, connector } = await body(req);
  if (action === "start")
    return NextResponse.json(
      await startTest(
        id,
        connector === undefined ? undefined : Number(connector),
      ),
    );
  if (action === "stop") return NextResponse.json(await stopTest(id));
  throw new HttpError(400, "invalid_input", "action must be start or stop.");
});
