import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  checkPassword,
  gate,
  issueToken,
  loginAllowed,
  recordLoginFailure,
  sameOrigin,
} from "@/lib/server/auth";
import { HttpError } from "@/lib/server/errors";
import { fail } from "@/lib/server/http";
import { body } from "@/lib/server/route";

const secure = (req: NextRequest) =>
  (
    req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol
  ).startsWith("https");

/** Sign in with the operator password; sets a signed httpOnly cookie. */
export async function POST(req: NextRequest) {
  try {
    if (!sameOrigin(req))
      throw new HttpError(
        403,
        "cross_origin",
        "Sign in from the installer kit itself.",
      );
    const g = gate();
    if (g.mode === "missing")
      throw new HttpError(503, "operator_password_missing", g.reason);
    if (g.mode === "open") return NextResponse.json({ ok: true });
    if (!loginAllowed())
      throw new HttpError(
        429,
        "too_many_attempts",
        "Too many attempts; wait a minute.",
      );
    const { password } = await body(req);
    if (typeof password !== "string" || !checkPassword(password, g.password)) {
      recordLoginFailure();
      throw new HttpError(
        401,
        "wrong_password",
        "That password is not correct.",
      );
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, issueToken(g.password), {
      httpOnly: true,
      secure: secure(req),
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return res;
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  if (!sameOrigin(req))
    return fail(
      new HttpError(
        403,
        "cross_origin",
        "Sign out from the installer kit itself.",
      ),
    );
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
