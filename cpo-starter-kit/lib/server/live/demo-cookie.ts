import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
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

async function jar() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/** The visitor's own demo commands, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoLive(): DemoLiveCookie {
  return {
    async load() {
      const c = await jar();
      return c ? decodeDemoLive(c.get(COOKIE)?.value) : outsideRequest.load();
    },
    async save(state) {
      const c = await jar();
      if (!c) return outsideRequest.save(state);
      c.set(COOKIE, encodeDemoLive(state), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
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
