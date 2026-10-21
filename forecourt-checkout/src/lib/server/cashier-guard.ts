import "server-only";
import { isCashier } from "@/lib/server/auth";
import { sameOrigin } from "@/lib/server/http";
import { settings } from "@/lib/server/services";
import { UserError } from "@/lib/server/sessions";

/** Every cashier route: same-origin writes, a cashier or operator cookie, and pay in store enabled. */
export async function cashierRequest(request: Request) {
  if (request.method !== "GET" && !sameOrigin(request))
    throw new UserError(403, "forbidden", "Cross-site request refused.");
  const s = settings();
  if (!s.payInStore)
    throw new UserError(
      404,
      "pay_in_store_off",
      "Pay in store is off. Set CASHIER_PASSWORD to turn it on.",
    );
  if (!(await isCashier(s)))
    throw new UserError(
      401,
      "not_signed_in",
      "Sign in to the cashier console.",
    );
  return s;
}

export const noStore = { headers: { "Cache-Control": "no-store" } };
