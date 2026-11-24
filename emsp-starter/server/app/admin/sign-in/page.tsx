import type { Metadata } from "next";
import { SIGN_IN_LIMITS } from "@/lib/accounts/sign-in";
import { SignIn } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return <SignIn codesPerHour={SIGN_IN_LIMITS.code.perEmail.limit} />;
}
