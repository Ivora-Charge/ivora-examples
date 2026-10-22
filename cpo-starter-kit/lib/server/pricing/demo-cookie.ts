import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import {
  decodeDemoPricing,
  encodeDemoPricing,
  type DemoPricingCookie,
} from "./demo";

const COOKIE = "cpo_demo_pricing";

/** The visitor's own demo tariffs and assignments, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoPricing(): DemoPricingCookie {
  return {
    async load() {
      return decodeDemoPricing((await cookies()).get(COOKIE)?.value);
    },
    async save(state) {
      (await cookies()).set(COOKIE, encodeDemoPricing(state), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Back to the sample tariffs. */
export async function resetDemoPricing() {
  (await cookies()).delete(COOKIE);
}
