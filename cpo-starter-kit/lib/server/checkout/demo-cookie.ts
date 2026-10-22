import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import {
  decodeDemoCheckout,
  emptyDemoCheckout,
  encodeDemoCheckout,
  memoryDemoCheckout,
  type DemoCheckoutCookie,
} from "./demo";

const COOKIE = "cpo_demo_checkout";

/** Outside a request (tests, scripts) there is no cookie: keep checkouts in memory. */
const outsideRequest = memoryDemoCheckout();

async function jar() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/** The visitor's own demo checkouts, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoCheckout(): DemoCheckoutCookie {
  return {
    async load() {
      const c = await jar();
      return c
        ? decodeDemoCheckout(c.get(COOKIE)?.value)
        : outsideRequest.load();
    },
    async save(state) {
      const c = await jar();
      if (!c) return outsideRequest.save(state);
      c.set(COOKIE, encodeDemoCheckout(state), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Tests: forget what was kept outside a request. */
export function resetDemoCheckoutForTests() {
  outsideRequest.state = emptyDemoCheckout();
}
