import type { Metadata } from "next";
import { adminEnabled } from "@/lib/server/admin";
import { ocpiUrls } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { DEMO_DRIVER_REF } from "@/lib/tokens/registry";
import { TokenAdmin } from "./token-admin";

export const metadata: Metadata = { title: "Driver tokens" };

export default function TokensPage() {
  return (
    <>
      <h1>Driver tokens</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">Who can charge</h2>
        <p>
          Each driver has an app token with a contract ID, and may have RFID
          cards on the same contract. Every change is pushed to each CPO at
          once; CPOs can also pull every token from{" "}
          <code className="wrap">{ocpiUrls().tokens}</code> and ask us in real
          time before a driver charges.
        </p>
        {isDemo() && (
          <p className="note">
            Demo mode: tokens are kept in memory only and nothing is pushed to a
            CPO. Look up the sample driver <code>{DEMO_DRIVER_REF}</code>.
          </p>
        )}
        {!adminEnabled() && (
          <p className="note">
            Admin actions are disabled until <code>ADMIN_SECRET</code> (at least
            32 characters) is set on the server.
          </p>
        )}
        <p className="note">
          Temporary: drivers get their app token here until driver sign-in
          arrives, and these actions ask for <code>ADMIN_SECRET</code> until
          admin sign-in does.
        </p>
      </section>
      <TokenAdmin />
    </>
  );
}
