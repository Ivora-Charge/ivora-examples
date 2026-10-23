import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import {
  decodeDemoOcpi,
  emptyDemoOcpi,
  encodeDemoOcpi,
  memoryDemoOcpi,
  type DemoOcpiState,
  type DemoOcpiStore,
} from "./demo-ocpi";

const COOKIE = "cpo_demo_roaming";

/** Outside a request (tests, scripts) there is no cookie: keep the settings in memory. */
const outsideRequest = memoryDemoOcpi();

async function jar() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/** The visitor's demo roaming settings, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoOcpi(): DemoOcpiStore {
  return {
    async load() {
      const c = await jar();
      return c ? decodeDemoOcpi(c.get(COOKIE)?.value) : outsideRequest.load();
    },
    async save(s: DemoOcpiState) {
      const c = await jar();
      if (!c) return outsideRequest.save(s);
      c.set(COOKIE, encodeDemoOcpi(s), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Back to the defaults (publishing off, no party requested). */
export async function resetDemoOcpi() {
  (await cookies()).delete(COOKIE);
}

/** Tests: forget what was kept outside a request. */
export function resetDemoOcpiForTests() {
  outsideRequest.state = emptyDemoOcpi();
}
