import type { Metadata } from "next";
import { currentAdmin } from "@/lib/accounts/admin-session";
import { adminEnabled } from "@/lib/server/admin";
import { isDemo } from "@/lib/server/demo";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Admin sign-in" };

export default async function SignInPage() {
  const admin = await currentAdmin();
  return (
    <>
      <h1>Admin sign-in</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">Who can sign in</h2>
        {admin ? (
          <p role="status">
            Signed in as {admin.email} (
            {admin.role === "admin" ? "admin" : "read only"}).
          </p>
        ) : (
          <p>
            No password: we email you a one-time code. Only accounts listed in
            the admin role table (<code>emsp_admins</code>) can use the admin
            web; see the server README for adding the first admin.
          </p>
        )}
        {isDemo() && (
          <p className="note">
            Demo mode: no email is sent and there are no admin accounts. Admin
            actions take <code>ADMIN_SECRET</code> instead
            {adminEnabled() ? "" : ", which is not set on this server"}.
          </p>
        )}
      </section>
      <SignInForm signedIn={admin !== null} />
    </>
  );
}
