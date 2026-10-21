import { NextResponse } from "next/server";
import { z } from "zod";
import { authorize } from "@/lib/server/cashier";
import { errorResponse } from "@/lib/server/http";
import { cashierRequest, noStore } from "@/lib/server/cashier-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const input = z.object({
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/),
  connector: z.number().int().min(1).max(99),
  mode: z.enum(["prepay", "postpay"]),
  prepaidCents: z.number().int().nullable().default(null),
  limitWh: z.number().int().nullable().default(null),
  // One key per authorisation on the console: a retry after a timeout reuses it.
  requestId: z.uuid(),
});

/** The cashier authorises a charger (pay after) or starts a prepaid sale. */
export async function POST(request: Request) {
  try {
    const s = await cashierRequest(request);
    const body = input.parse(await request.json());
    const view = await authorize(
      {
        code: body.code,
        connector: body.connector,
        requestId: body.requestId,
        terms: {
          mode: body.mode,
          prepaidCents: body.mode === "prepay" ? body.prepaidCents : null,
          limitWh: body.mode === "prepay" ? body.limitWh : null,
        },
      },
      s,
    );
    return NextResponse.json(view, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
