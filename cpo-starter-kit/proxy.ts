import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { config as settings, isDemo } from "@/lib/server/env";
import { authCookieOptions } from "@/lib/server/supabase";

/**
 * Pages anyone may open: everything else needs a signed-in staff member. /c/ is where
 * QR stickers lead drivers.
 */
const PUBLIC = ["/login", "/setup", "/invite", "/auth/", "/c/"];

/**
 * Refreshes the Supabase session cookies on each request (server components cannot
 * write cookies) and sends signed-out visitors to the sign-in page. This is only the
 * first, optimistic check: every page and server action still calls requireRole().
 * Demo mode has no Supabase, so the proxy does nothing.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (isDemo()) return response;
  const supabase = createServerClient(
    settings.supabaseUrl,
    settings.supabaseAnonKey,
    {
      cookieOptions: authCookieOptions(),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values) {
          for (const { name, value } of values)
            request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of values)
            response.cookies.set(name, value, options);
        },
      },
    },
  );
  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  if (!data?.claims?.sub && !PUBLIC.some((p) => path.startsWith(p))) {
    const login = NextResponse.redirect(new URL("/login", request.url));
    for (const c of response.cookies.getAll()) login.cookies.set(c);
    response = login;
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  // Everything but static files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico)$).*)",
  ],
};
