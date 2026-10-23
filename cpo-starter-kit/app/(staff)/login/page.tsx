import Link from "next/link";
import { redirect } from "next/navigation";
import { currentStaff } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import { getTeam } from "@/lib/server/team";
import { LinkForm, PasswordForm } from "./forms";

export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  link: "That sign-in link has expired or was already used. Ask for a new one.",
  no_access:
    "This login is not on the team. Ask an owner or manager for an invite.",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (isDemo())
    return (
      <>
        <h1>Sign in</h1>
        <section className="card">
          <p className="notice" role="note">
            Demo mode: you are already signed in as the demo owner. Staff sign
            in here with email and password, or an emailed link, once Supabase
            is connected.
          </p>
          <Link className="button" href="/">
            Go to the overview
          </Link>
        </section>
      </>
    );

  if (await currentStaff()) redirect("/");
  const { error } = await searchParams;
  const needsSetup = !(await getTeam().backend.hasStaff());

  return (
    <>
      <h1>Sign in</h1>
      {error && ERRORS[error] && (
        <p className="error" role="alert">
          {ERRORS[error]}
        </p>
      )}
      {needsSetup && (
        <p className="notice" role="note">
          Nobody is set up yet.{" "}
          <Link href="/setup">Create the first owner</Link> with your setup
          secret.
        </p>
      )}
      <section className="card" aria-labelledby="password-heading">
        <h2 id="password-heading">Email and password</h2>
        <PasswordForm />
      </section>
      <section className="card" aria-labelledby="link-heading">
        <h2 id="link-heading">Email me a sign-in link</h2>
        <LinkForm />
      </section>
      <p className="muted">
        New staff join by invite. Ask an owner or manager to invite you.
      </p>
    </>
  );
}
