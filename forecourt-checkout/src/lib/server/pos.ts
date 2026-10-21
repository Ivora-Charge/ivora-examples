import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  posSale,
  posStatusOf,
  type PosPaidResult,
  type PosSale,
  type PosStatus,
} from "../pos";
import { SaleError, type PaymentMethod, type SaleView } from "../store";
import { trustedClient } from "./client";
import { UserError } from "./sessions";

// Inbound POS endpoints: POST /api/pos/mark-paid and GET /api/pos/sessions.
// Both take `Authorization: Bearer <POS_API_SECRET>`. Mark-paid goes through
// the same markSalePaid() as the cashier console, so Ivora gets the same
// settlement reports either way.

/** Constant-time check of `Authorization: Bearer <secret>`, without leaking the length. */
export function bearerMatches(header: string | null, secret: string) {
  if (!secret || !header) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export const markPaidInput = z.object({
  sale_id: z.string().min(1).max(40),
  amount_minor: z.number().int().min(0).max(10_000_000),
  method: z.enum(["cash", "card"]),
  pos_reference: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((v) => v || null),
});
export type MarkPaidInput = z.infer<typeof markPaidInput>;

export type MarkPaid = (input: {
  sale: string;
  amountCents: number;
  method: PaymentMethod;
  posReference: string | null;
}) => Promise<SaleView>;

const codeOf = (e: unknown) =>
  e instanceof UserError || e instanceof SaleError ? e.code : null;

/**
 * Idempotent by sale ID: the first call records the payment; a repeat with
 * the same amount, method and POS reference returns the same result; any
 * other values get 409. The amount must be exactly what the final bill leaves
 * to collect (422 otherwise), and a sale that hasn't finished is refused (409).
 */
export async function posMarkPaid(
  input: MarkPaidInput,
  markPaid: MarkPaid,
): Promise<PosPaidResult> {
  let view: SaleView;
  try {
    view = await markPaid({
      sale: input.sale_id,
      amountCents: input.amount_minor,
      method: input.method,
      posReference: input.pos_reference,
    });
  } catch (error) {
    const code = codeOf(error);
    if (code === "amount_mismatch")
      throw new UserError(422, code, (error as Error).message);
    if (code === "already_paid")
      throw new UserError(
        409,
        "idempotency_conflict",
        "This sale is already settled with different values.",
      );
    if (code === "bill_not_final")
      throw new UserError(
        409,
        "session_not_finished",
        "The charging session hasn't finished. Mark it paid when the bill is final.",
      );
    throw error;
  }
  const step = view.terms.mode === "prepay" ? "extra" : "paid";
  const payment = view.amounts?.payments.find((p) => p.step === step);
  if (
    !payment ||
    payment.amountCents !== input.amount_minor ||
    payment.method !== input.method ||
    payment.posReference !== input.pos_reference
  )
    throw new UserError(
      409,
      "idempotency_conflict",
      "This sale was already marked paid with different values.",
    );
  return {
    sale_id: view.sale,
    status: "paid",
    amount_minor: payment.amountCents,
    method: input.method,
    pos_reference: payment.posReference,
    currency: view.currency,
  };
}

/** Sales for GET /api/pos/sessions, filtered by status. */
export function posSales(views: SaleView[], status: PosStatus): PosSale[] {
  return views
    .filter((v) => posStatusOf(v) === status)
    .map((v) => posSale(v, status));
}

/** Best-effort fixed-window limit per client and server instance. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; since: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}
  allow(key: string, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || now - entry.since > this.windowMs) {
      this.hits.set(key, { count: 1, since: now });
      if (this.hits.size > 5000)
        this.hits.delete(this.hits.keys().next().value!);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

/**
 * The key for the POS limits: trustedClient(), or one shared bucket for every
 * caller when no trusted source gives an address, so token guessing stays
 * limited (a flood can then hold back the real POS too).
 */
export const clientOf = (request: Request) =>
  trustedClient(request.headers) ?? "shared";
