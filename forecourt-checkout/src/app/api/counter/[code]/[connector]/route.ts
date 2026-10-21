import { NextResponse } from "next/server";
import { counter } from "@/lib/server/cashier";
import { counterAllowed } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { settings } from "@/lib/server/services";
import { UserError } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The driver's "pay at the counter" screen polls this for the charger's in-store sale. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string; connector: string }> },
) {
  try {
    const { code, connector } = await params;
    const s = settings();
    const client =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!counterAllowed(client))
      throw new UserError(
        429,
        "rate_limited",
        "Too many requests. Wait a moment.",
      );
    if (!s.payInStore)
      throw new UserError(404, "pay_in_store_off", "Pay in store is off.");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(code) ||
      !/^\d{1,2}$/.test(connector)
    )
      throw new UserError(
        404,
        "charger_not_found",
        "This QR code is not valid.",
      );
    return NextResponse.json(await counter(code, Number(connector), s), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
