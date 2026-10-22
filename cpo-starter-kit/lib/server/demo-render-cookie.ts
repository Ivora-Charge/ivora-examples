import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { config } from "./env";

/** This request's latest demo cookie values (one map per request). */
const written = cache(() => new Map<string, string>());

async function jar() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/**
 * A demo-mode cookie that settlement may also change while a page renders (a driver's
 * page settles their session as it reads it). Server actions save it as usual; a
 * page can't set cookies, so there the change is kept for the rest of that request
 * only, and the next server action saves the state it reads. The demo's simulation is
 * deterministic, so a later render works out the same result again. Null outside a
 * request (tests, scripts).
 */
export async function demoRenderCookie(name: string) {
  const c = await jar();
  if (!c) return null;
  return {
    read(): string | undefined {
      return written().get(name) ?? c.get(name)?.value;
    },
    write(value: string) {
      written().set(name, value);
      try {
        c.set(name, value, {
          httpOnly: true,
          sameSite: "lax",
          secure: config.appUrl.startsWith("https:"),
          path: "/",
          maxAge: 7 * 24 * 3600,
        });
      } catch {
        // Rendering a page: cookies are read-only here (kept for this request above).
      }
    },
  };
}
