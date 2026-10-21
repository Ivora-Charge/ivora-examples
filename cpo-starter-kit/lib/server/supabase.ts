import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { config, isDemo } from "./env";

// Supabase is used on the server only. The browser never sees a Supabase key or token:
// the session lives in HTTP-only cookies that the SSR client reads and refreshes.

function refuseInDemo() {
  // Second guard behind getTeam(): demo mode never talks to Supabase.
  if (isDemo()) throw new Error("Demo mode never calls Supabase");
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: config.appUrl.startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
  };
}

/** Service-role client: bypasses RLS, so only call it after checking the role. */
export function serviceClient() {
  refuseInDemo();
  return createClient<Database>(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

/** The signed-in staff member's own session; reads go through RLS. */
export async function sessionClient() {
  refuseInDemo();
  const jar = await cookies();
  return createServerClient<Database>(
    config.supabaseUrl,
    config.supabaseAnonKey,
    {
      cookieOptions: authCookieOptions(),
      cookies: {
        getAll: () => jar.getAll(),
        setAll(values) {
          try {
            for (const { name, value, options } of values)
              jar.set(name, value, options);
          } catch {
            // Server components cannot set cookies; the proxy refreshes them instead.
          }
        },
      },
    },
  );
}
