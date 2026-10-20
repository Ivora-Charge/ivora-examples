import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  checkPassword,
  gate,
  issueToken,
  loginAllowed,
  recordLoginFailure,
  sameOrigin,
} from "@/lib/auth";

const isHttps = (req: Request) =>
  (
    req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol
  ).startsWith("https");

/** Sign in with OPERATOR_PASSWORD; sets a signed, httpOnly, SameSite=Strict cookie. */
export async function POST(req: Request) {
  if (!sameOrigin(req))
    return NextResponse.json(
      { error: "Cross-origin request refused" },
      { status: 403 },
    );
  const g = gate();
  if (g.mode === "missing")
    return NextResponse.json({ error: g.reason }, { status: 503 });
  if (g.mode === "open") return NextResponse.json({ ok: true });
  if (!loginAllowed())
    return NextResponse.json(
      { error: "Too many attempts; wait a minute." },
      { status: 429 },
    );
  const b = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (
    typeof b.password !== "string" ||
    !checkPassword(b.password, g.password)
  ) {
    recordLoginFailure();
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, issueToken(g.password), {
    httpOnly: true,
    secure: isHttps(req),
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return res;
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req))
    return NextResponse.json(
      { error: "Cross-origin request refused" },
      { status: 403 },
    );
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
