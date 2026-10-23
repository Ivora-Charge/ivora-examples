import { isDemo } from "@/lib/server/env";
import { ConfirmSignIn } from "./confirm";

export const metadata = { title: "Sign in" };

// The emailed sign-in link carries its token in the URL fragment. Opening the page
// does not sign in: a button press does, so an email scanner that follows links
// cannot use up the link.
export default function Page() {
  return (
    <>
      <h1>Sign in</h1>
      {isDemo() ? (
        <p className="notice" role="note">
          Demo mode: you are already signed in as the demo owner.
        </p>
      ) : (
        <ConfirmSignIn />
      )}
    </>
  );
}
