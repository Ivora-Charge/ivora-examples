import { NextResponse } from "next/server";
import { body, guarded, type IdContext } from "@/lib/server/route";
import { changeConfig, readConfig } from "@/lib/server/service";

/**
 * { action: "read" } reads the heartbeat and meter intervals back from the
 * charger; { key, value } changes one of them and then reads back.
 */
export const POST = guarded({ write: true }, async (req, ctx: IdContext) => {
  const id = (await ctx.params).id;
  const input = await body(req);
  if (input.action === "read")
    return NextResponse.json({ charger: await readConfig(id) });
  return NextResponse.json(await changeConfig(id, input));
});
