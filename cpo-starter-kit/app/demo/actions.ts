"use server";

import { redirect } from "next/navigation";
import { getCheckout } from "@/lib/server/checkout";
import { isDemo } from "@/lib/server/env";
import { authorizeDemoPayment } from "@/lib/server/ivora/demo";
import { cookieDemoFleet } from "@/lib/server/ivora/demo-cookie";

// Demo mode only: the simulated Stripe checkout. It changes the visitor's own demo
// cookie and nothing else; in live mode it does nothing.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, 128) : "";
};

/**
 * "Pay with demo card": authorizes the simulated hold, then returns to the sticker's
 * page, where the driver follows the session (live, Stripe returns to Ivora's page,
 * which can't show it yet). Nothing is charged.
 */
export async function demoPayAction(form: FormData) {
  if (!isDemo()) return;
  const r = await authorizeDemoPayment(cookieDemoFleet(), str(form, "payment"));
  if (!r) return;
  const rec = await getCheckout().store.getByReference(r.returnReference);
  redirect(rec ? `/c/${rec.stickerCode}` : "/");
}
