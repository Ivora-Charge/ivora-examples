import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
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

async function jar() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/**
 * The visitor's own demo sites, chargers and test sessions, in an HTTP-only cookie.
 * Pages only read it; server actions write it.
 */
export function cookieDemoFleet(): DemoFleetStore {
  return {
    async load() {
      const c = await jar();
      return c ? decodeDemoFleet(c.get(COOKIE)?.value) : outsideRequest.load();
    },
    async save(f: DemoFleet) {
      const c = await jar();
      if (!c) return outsideRequest.save(f);
      c.set(COOKIE, encodeDemoFleet(f), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
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
