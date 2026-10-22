import { NextResponse, type NextRequest } from "next/server";
import { config, isDemo } from "@/lib/server/env";
import { completeCodeSignIn, getTeam, TeamError } from "@/lib/server/team";

// Supabase's own sign-in email (used when no email provider is set) returns here
// with a one-time PKCE code.
export async function GET(request: NextRequest) {
  const to = (path: string) =>
    NextResponse.redirect(new URL(path, config.appUrl), {
      headers: { "Cache-Control": "private, no-store" },
    });
  if (isDemo()) return to("/");
  try {
    await completeCodeSignIn(
      getTeam(),
      request.nextUrl.searchParams.get("code") ?? "",
    );
    return to("/");
  } catch (e) {
    if (!(e instanceof TeamError))
      console.error("cpo-starter-kit: sign-in callback failed:", {
        error: e instanceof Error ? e.name : "error",
      });
    return to(
      e instanceof TeamError && e.code === "no_access"
        ? "/login?error=no_access"
        : "/login?error=link",
    );
  }
}
