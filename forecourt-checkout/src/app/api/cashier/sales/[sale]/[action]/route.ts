import { NextResponse } from "next/server";
import { z } from "zod";
import { saleAction, type SaleAction } from "@/lib/server/cashier";
import { errorResponse } from "@/lib/server/http";
import { UserError } from "@/lib/server/sessions";
import { cashierRequest, noStore } from "@/lib/server/cashier-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const paid = z.object({
  amountCents: z.number().int().min(0).max(10_000_000),
  method: z.enum(["cash", "card"]),
  posReference: z
    .string()
    .trim()
    .max(40)
    .transform((v) => v || null)
    .nullable()
    .default(null),
});

/** Stop, mark paid, give change, or (demo only) unplug. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sale: string; action: string }> },
) {
  try {
    const s = await cashierRequest(request);
    const { sale, action } = await params;
    let input: SaleAction;
    if (action === "paid")
      input = { action, ...paid.parse(await request.json()) };
    else if (action === "stop" || action === "unplug" || action === "change")
      input = { action };
    else throw new UserError(404, "not_found", "Unknown action.");
    return NextResponse.json(await saleAction(sale, input, s), noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
