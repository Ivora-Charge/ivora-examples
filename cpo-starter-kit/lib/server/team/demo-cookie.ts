import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import { decodeDemoState, encodeDemoState, type DemoStore } from "./demo";

const COOKIE = "cpo_demo_team";

/** The visitor's own demo team, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoStore(): DemoStore {
  return {
    async load() {
      return decodeDemoState((await cookies()).get(COOKIE)?.value);
    },
    async save(state) {
      (await cookies()).set(COOKIE, encodeDemoState(state), {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appUrl.startsWith("https:"),
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
    },
  };
}

/** Back to the sample team. */
export async function resetDemoTeam() {
  (await cookies()).delete(COOKIE);
}
