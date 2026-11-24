import type { Metadata } from "next";
import {
  isTokenHash,
  RESEND_COOLDOWN_MS,
  SIGN_IN_LIMITS,
} from "@/lib/accounts/sign-in";
import { adminEnabled } from "@/lib/server/admin";
import { SignIn } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

// Whether ADMIN_SECRET is set is read at request time, not when the app is built.
export const dynamic = "force-dynamic";

/**
 * Only this page is told whether ADMIN_SECRET is set on the deployment, because only
 * this page offers it. No other page's data carries that.
 *
 * The sign-in email's link may lead here with `?token_hash=...` (see the README). The
 * page does nothing with it by itself: it shows a button, and the button sends it.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const hash = (await searchParams)?.token_hash;
  return (
    <SignIn
      limits={{
        counts: SIGN_IN_LIMITS,
        cooldown: RESEND_COOLDOWN_MS / 1000,
      }}
      secretEnabled={adminEnabled()}
      link={isTokenHash(hash) ? hash : null}
    />
  );
}
