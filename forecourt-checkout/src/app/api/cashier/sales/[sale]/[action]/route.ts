import { NextResponse } from "next/server";
import { z } from "zod";
import {
  emailReceipt,
  saleAction,
  type SaleAction,
} from "@/lib/server/cashier";
import { consoleLogin } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { clientOf, RateLimiter } from "@/lib/server/pos";
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

const email = z.object({
  // Used for this one send; never stored or logged.
  email: z.string().trim().max(254),
  // One per tap on "Email receipt": a retry reuses it, so it never sends twice.
  requestId: z.uuid(),
});

// Emailed receipts: a brake per server instance on how many one signed-in
// console sends from one client, so one busy till doesn't block the others.
const emails = new RateLimiter(20);

/** Stop, mark paid, give change, email the receipt, or (demo only) unplug. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sale: string; action: string }> },
) {
  try {
    const s = await cashierRequest(request);
    const { sale, action } = await params;
    if (action === "email") {
      const login = (await consoleLogin(s)) ?? "none";
      if (!emails.allow(`${login}|${clientOf(request)}`))
        throw new UserError(
          429,
          "rate_limited",
          "Too many emails. Wait a minute.",
        );
      const body = email.parse(await request.json());
      return NextResponse.json(
        await emailReceipt(sale, body.email, body.requestId, s),
        noStore,
      );
    }
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
