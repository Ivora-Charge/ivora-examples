import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import {
  decodeDemoChargers,
  encodeDemoChargers,
  type DemoChargersCookie,
} from "./demo";

const COOKIE = "cpo_demo_chargers";

/** The visitor's own demo charger records, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoChargers(): DemoChargersCookie {
  return {
    async load() {
      return decodeDemoChargers((await cookies()).get(COOKIE)?.value);
    },
    async save(state) {
      (await cookies()).set(COOKIE, encodeDemoChargers(state), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Back to the sample chargers only. */
export async function resetDemoChargers() {
  (await cookies()).delete(COOKIE);
}
