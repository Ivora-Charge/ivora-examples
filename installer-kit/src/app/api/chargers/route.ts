import { NextResponse } from "next/server";
import { qrSvg } from "@/lib/qr";
import { body, guarded } from "@/lib/server/route";
import { addCharger } from "@/lib/server/service";

/**
 * Register the station, set its password and return the connection details.
 * This is the only response that ever contains the password.
 */
export const POST = guarded({ write: true }, async (req) => {
  const result = await addCharger(await body(req));
  return NextResponse.json(
    {
      ...result,
      qr: {
        url: await qrSvg(result.charger.connectionUrl),
        password: result.password ? await qrSvg(result.password) : null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
