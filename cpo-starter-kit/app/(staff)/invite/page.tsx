import { isDemo } from "@/lib/server/env";
import { AcceptInvite } from "./accept";

export const metadata = { title: "Join the team" };

// The invite token is in the URL fragment, which the browser never sends to the
// server, so it stays out of request logs. The page reads it in the browser.
export default function Page() {
  return (
    <>
      <h1>Join the team</h1>
      <AcceptInvite demo={isDemo()} />
    </>
  );
}
