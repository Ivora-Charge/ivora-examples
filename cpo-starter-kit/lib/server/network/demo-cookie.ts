import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import {
  decodeDemoNetwork,
  encodeDemoNetwork,
  memoryDemoNetwork,
  type DemoNetworkCookie,
} from "./demo";

const COOKIE = "cpo_demo_network";

/** Outside a request (tests, scripts) there is no cookie: keep the state in memory. */
const outsideRequest = memoryDemoNetwork();

async function jar() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/**
 * The visitor's own demo fee versions and payout status, in an HTTP-only cookie.
 * Saved only by server actions.
 */
export function cookieDemoNetwork(): DemoNetworkCookie {
  return {
    async load() {
      const j = await jar();
      return j
        ? decodeDemoNetwork(j.get(COOKIE)?.value)
        : outsideRequest.load();
    },
    async save(state) {
      const j = await jar();
      if (!j) return outsideRequest.save(state);
      j.set(COOKIE, encodeDemoNetwork(state), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Back to the sample fees and payout status. */
export async function resetDemoNetwork() {
  (await jar())?.delete(COOKIE);
}
