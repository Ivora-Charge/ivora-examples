import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import {
  decodeDemoOnboarding,
  encodeDemoOnboarding,
  type DemoOnboardingCookie,
} from "./demo";

const COOKIE = "cpo_demo_onboarding";

/** The visitor's own demo company, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoOnboarding(): DemoOnboardingCookie {
  return {
    async load() {
      return decodeDemoOnboarding((await cookies()).get(COOKIE)?.value);
    },
    async save(state) {
      (await cookies()).set(COOKIE, encodeDemoOnboarding(state), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Back to an empty demo company. */
export async function resetDemoOnboarding() {
  (await cookies()).delete(COOKIE);
}
