import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import {
  decodeDemoCards,
  emptyDemoCards,
  encodeDemoCards,
  memoryDemoCards,
  type DemoCardsState,
  type DemoCardsStore,
} from "./demo-cards";

const COOKIE = "cpo_demo_cards";

/** Outside a request (tests, scripts) there is no cookie: keep the cards in memory. */
const outsideRequest = memoryDemoCards();

async function jar() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/** The visitor's demo cards, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoCards(): DemoCardsStore {
  return {
    async load() {
      const c = await jar();
      return c ? decodeDemoCards(c.get(COOKIE)?.value) : outsideRequest.load();
    },
    async save(s: DemoCardsState) {
      const c = await jar();
      if (!c) return outsideRequest.save(s);
      c.set(COOKIE, encodeDemoCards(s), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Back to the sample cards. */
export async function resetDemoCards() {
  (await cookies()).delete(COOKIE);
}

/** Tests: forget what was kept outside a request. */
export function resetDemoCardsForTests() {
  outsideRequest.state = emptyDemoCards();
}
