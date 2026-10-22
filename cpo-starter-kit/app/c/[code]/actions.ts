"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import {
  CheckoutError,
  getCheckout,
  payAndCharge,
  startPaidSession,
} from "@/lib/server/checkout";
import {
  DEMO_CHECKOUT_SIMULATIONS,
  type DemoCheckoutSimulation,
} from "@/lib/server/checkout/demo";
import { cookieDemoCheckout } from "@/lib/server/checkout/demo-cookie";
import {
  driverCheckoutIds,
  rememberDriverCheckout,
} from "@/lib/server/checkout/driver-cookie";
import { config, isDemo } from "@/lib/server/env";
import { sourceOf } from "@/lib/server/rate-limit";

// Public actions: drivers are not staff. They carry only the sticker's code and a
// random request ID; everything else (charger, connector, price, private, Stripe) is
// looked up and checked on the server.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, 64) : "";
};

function failure(e: unknown): ActionState {
  if (e instanceof CheckoutError)
    return {
      error: e.message,
      errorDetail: {
        kind: e.code,
        apiCode: e.apiCode,
        requestId: e.requestId,
      },
    };
  console.error("cpo-starter-kit: checkout failed:", {
    error: e instanceof Error ? e.name : "error",
  });
  return {
    error:
      "Something went wrong on our side, and nothing was charged. Try again in a minute.",
    errorDetail: { kind: "server_error" },
  };
}

/** "Pay and charge": sends the driver to Ivora Checkout (in demo mode, the demo's own). */
export async function payAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const code = str(form, "code");
  let url: string;
  try {
    const r = await payAndCharge(
      getCheckout(),
      {
        code,
        requestId: str(form, "requestId"),
        source: sourceOf(await headers()),
      },
      config.operatorName,
    );
    await rememberDriverCheckout(r.id);
    url = r.url;
  } catch (e) {
    revalidatePath(`/c/${code}`);
    return failure(e);
  }
  redirect(url);
}

/** Starts a paid session whose automatic start was refused (this browser's own). */
export async function startAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const code = str(form, "code");
  try {
    await startPaidSession(
      getCheckout(),
      { code, id: str(form, "id"), ids: await driverCheckoutIds() },
      config.operatorName,
    );
  } catch (e) {
    return failure(e);
  }
  revalidatePath(`/c/${code}`);
  return {
    ok: `Start sent to the charger.${isDemo() ? " Demo: simulated, nothing was sent to a charger." : ""} The status above shows when charging begins.`,
  };
}

/** Demo mode only: what the sticker page simulates (an offline charger, …). */
export async function demoSimulateAction(form: FormData) {
  if (!isDemo()) return;
  const v = str(form, "simulate") as DemoCheckoutSimulation;
  if (!DEMO_CHECKOUT_SIMULATIONS.includes(v)) return;
  const cookie = cookieDemoCheckout();
  const s = await cookie.load();
  s.simulate = v;
  await cookie.save(s);
  revalidatePath(`/c/${str(form, "code")}`);
}
