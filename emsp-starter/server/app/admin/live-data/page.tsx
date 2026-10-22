import type { Metadata } from "next";
import Link from "next/link";
import { adminEnabled } from "@/lib/server/admin";
import { isDemo } from "@/lib/server/demo";
import { LiveDataAdmin } from "./live-data-admin";

export const metadata: Metadata = { title: "Live data" };

export default function LiveDataPage() {
  return (
    <>
      <h1>Live data</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">State of charge and more</h2>
        <p>
          OCPI 2.2.1 has no state of charge. A{" "}
          <Link href="/admin/peers">CPO peer</Link> can have a read-only
          live-data adapter that reads it from the CPO&apos;s own API; the app
          shows it when the adapter returns one, and hides it otherwise. Peers
          without an adapter show OCPI data only.
        </p>
        {isDemo() && (
          <p className="note">
            Demo mode: the mock CPO&apos;s charging session shows an invented
            state of charge. Adapters saved here stay in memory and are never
            called: nothing is sent to a CPO.
          </p>
        )}
        {!adminEnabled() && (
          <p className="note">
            Admin actions are disabled until <code>ADMIN_SECRET</code> (at least
            32 characters) is set on the server.
          </p>
        )}
      </section>
      <LiveDataAdmin />
    </>
  );
}
