import "server-only";
import { cookies } from "next/headers";
import { demoRenderCookie } from "../demo-render-cookie";
import {
  decodeDemoLive,
  emptyDemoLive,
  encodeDemoLive,
  memoryDemoLive,
  type DemoLiveCookie,
} from "./demo";

const COOKIE = "cpo_demo_live";

/** Outside a request (tests, scripts) there is no cookie: keep commands in memory. */
const outsideRequest = memoryDemoLive();

/**
 * The visitor's own demo commands (and tokens and transaction marks), in an HTTP-only
 * cookie. Server actions save it; a driver's page that finds their free session moves
 * the station's mark for its own render only (see demoRenderCookie).
 */
export function cookieDemoLive(): DemoLiveCookie {
  return {
    async load() {
      const c = await demoRenderCookie(COOKIE);
      return c ? decodeDemoLive(c.read()) : outsideRequest.load();
    },
    async save(state) {
      const c = await demoRenderCookie(COOKIE);
      if (!c) return outsideRequest.save(state);
      c.write(encodeDemoLive(state));
    },
  };
}

/** Forget the demo commands. */
export async function resetDemoLive() {
  (await cookies()).delete(COOKIE);
}

/** Tests: forget what was kept outside a request. */
export function resetDemoLiveForTests() {
  outsideRequest.state = emptyDemoLive();
}
