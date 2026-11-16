import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import { decodeDemoHosts, encodeDemoHosts, type DemoHostStore } from "./demo";

const COOKIE = "cpo_demo_hosts";
/** Demo only: the sample host user the visitor is viewing the app as. */
const VIEW_AS = "cpo_demo_view_as";

const options = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.appUrl.startsWith("https:"),
  path: "/",
  maxAge: 7 * 24 * 3600,
});

/** The visitor's own demo hosts, in an HTTP-only cookie. Saved only by server actions. */
export function cookieDemoHosts(): DemoHostStore {
  return {
    async load() {
      return decodeDemoHosts((await cookies()).get(COOKIE)?.value);
    },
    async save(state) {
      (await cookies()).set(COOKIE, encodeDemoHosts(state), options());
    },
  };
}

/** Back to the two sample hosts. */
export async function resetDemoHosts() {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(VIEW_AS);
}

/**
 * Demo mode only: whose view the visitor is looking at. Null is the demo owner. The
 * value is only ever a sample team member's ID; currentStaff() checks it is a host
 * user of the visitor's own demo team before using it.
 */
export async function demoViewAs(): Promise<string | null> {
  const v = (await cookies()).get(VIEW_AS)?.value;
  return v && /^[0-9a-f-]{36}$/.test(v) ? v : null;
}

export async function setDemoViewAs(userId: string | null) {
  const jar = await cookies();
  if (userId === null) jar.delete(VIEW_AS);
  else jar.set(VIEW_AS, userId, options());
}
