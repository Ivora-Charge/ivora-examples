import "server-only";
import { cookies } from "next/headers";
import { demoRenderCookie } from "../demo-render-cookie";
import {
  decodeDemoFleet,
  emptyDemoFleet,
  encodeDemoFleet,
  memoryDemoFleet,
  type DemoFleet,
  type DemoFleetStore,
} from "./demo";

const COOKIE = "cpo_demo_fleet";

/** Outside a request (tests, scripts) there is no cookie: keep the fleet in memory. */
const outsideRequest = memoryDemoFleet();

/**
 * The visitor's own demo sites, chargers and test sessions, in an HTTP-only cookie.
 * Server actions write it; a page that settles a driver's session (a simulated
 * finalize, capture or release) keeps the change for its own render (see
 * demoRenderCookie).
 */
export function cookieDemoFleet(): DemoFleetStore {
  return {
    async load() {
      const c = await demoRenderCookie(COOKIE);
      return c ? decodeDemoFleet(c.read()) : outsideRequest.load();
    },
    async save(f: DemoFleet) {
      const c = await demoRenderCookie(COOKIE);
      if (!c) return outsideRequest.save(f);
      c.write(encodeDemoFleet(f));
    },
  };
}

/** Back to the sample fleet only. */
export async function resetDemoFleet() {
  (await cookies()).delete(COOKIE);
}

/** Tests: forget what was kept outside a request. */
export function resetDemoFleetForTests() {
  outsideRequest.state = emptyDemoFleet();
}
