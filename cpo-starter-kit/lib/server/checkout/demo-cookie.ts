import "server-only";
import { demoRenderCookie } from "../demo-render-cookie";
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

/**
 * The visitor's own demo checkouts, in an HTTP-only cookie. Server actions save it; a
 * page that settles a session keeps the change for its own render (see
 * demoRenderCookie).
 */
export function cookieDemoCheckout(): DemoCheckoutCookie {
  return {
    async load() {
      const c = await demoRenderCookie(COOKIE);
      return c ? decodeDemoCheckout(c.read()) : outsideRequest.load();
    },
    async save(state) {
      const c = await demoRenderCookie(COOKIE);
      if (!c) return outsideRequest.save(state);
      c.write(encodeDemoCheckout(state));
    },
  };
}

/** Tests: forget what was kept outside a request. */
export function resetDemoCheckoutForTests() {
  outsideRequest.state = emptyDemoCheckout();
}
