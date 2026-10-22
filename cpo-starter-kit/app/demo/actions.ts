"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isDemo } from "@/lib/server/env";
import { getIvora } from "@/lib/server/ivora";
import { authorizeDemoPayment } from "@/lib/server/ivora/demo";
import { cookieDemoFleet } from "@/lib/server/ivora/demo-cookie";

// Demo mode only: the simulated Stripe checkout and Ivora driver page. They change the
// visitor's own demo cookie and nothing else; in live mode they do nothing.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, 128) : "";
};

/** "Pay with demo card": authorizes the simulated hold. Nothing is charged. */
export async function demoPayAction(form: FormData) {
  if (!isDemo()) return;
  const r = await authorizeDemoPayment(cookieDemoFleet(), str(form, "payment"));
  if (!r) return;
  redirect(`/demo/charging/${encodeURIComponent(r.returnReference)}`);
}

/** "Stop charging" on the simulated driver page. */
export async function demoStopAction(form: FormData) {
  if (!isDemo()) return;
  const ivora = getIvora();
  const billId = str(form, "bill");
  const bill = await ivora.getBill(billId).catch(() => null);
  const tx = bill?.usage;
  if (bill && tx?.transaction_id && tx.active)
    await ivora.sendCommand(
      bill.station_id,
      { action: "stop", transaction_id: tx.transaction_id },
      `cpo-demo-${billId}-stop`,
    );
  revalidatePath(`/demo/charging/${str(form, "reference")}`);
}
