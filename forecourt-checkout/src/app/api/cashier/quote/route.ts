import { NextResponse } from "next/server";
import { z } from "zod";
import { quoteEnergy } from "@/lib/server/cashier";
import { errorResponse } from "@/lib/server/http";
import { MAX_LIMIT_WH } from "@/lib/store";
import { cashierRequest, noStore } from "@/lib/server/cashier-guard";

export const dynamic = "force-dynamic";

const input = z.object({
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/),
  connector: z.number().int().min(1).max(99),
  energyWh: z.number().int().min(1000).max(MAX_LIMIT_WH),
});

/** What a kWh limit costs, so the cashier knows what to take on the POS. */
export async function POST(request: Request) {
  try {
    const s = await cashierRequest(request);
    return NextResponse.json(
      await quoteEnergy(input.parse(await request.json()), s),
      noStore,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
