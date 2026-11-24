import type { Metadata } from "next";
import { SIGN_IN_LIMITS } from "@/lib/accounts/sign-in";
import { adminEnabled } from "@/lib/server/admin";
import { SignIn } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

// Whether ADMIN_SECRET is set is read at request time, not when the app is built.
export const dynamic = "force-dynamic";

/**
 * Only this page is told whether ADMIN_SECRET is set on the deployment, because only
 * this page offers it. No other page's data carries that.
 */
export default function SignInPage() {
  return (
    <SignIn
      codesPerHour={SIGN_IN_LIMITS.code.perEmail.limit}
      secretEnabled={adminEnabled()}
    />
  );
}
