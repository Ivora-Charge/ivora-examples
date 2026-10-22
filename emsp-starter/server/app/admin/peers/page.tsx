import type { Metadata } from "next";
import Link from "next/link";
import { ocpiUrls } from "@/lib/server/config";
import { adminEnabled } from "@/lib/server/admin";
import { isDemo } from "@/lib/server/demo";
import { PeerAdmin } from "./peer-admin";

export const metadata: Metadata = { title: "CPO peers" };

export default function PeersPage() {
  return (
    <>
      <h1>CPO peers</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">OCPI connections</h2>
        <p>
          Each CPO you partner with is an OCPI 2.2.1 peer. Register at a CPO
          with the Token A it gives you, or create a Token A for a CPO to
          register with us at{" "}
          <code className="wrap">{ocpiUrls().versions}</code>.
        </p>
        <p>
          To show drivers their car&apos;s state of charge, give a peer a{" "}
          <Link href="/admin/live-data">live-data adapter</Link>.
        </p>
        {isDemo() && (
          <p className="note">
            Demo mode: peers are kept in memory only, and nothing is sent to a
            CPO, so registering at one is refused.
          </p>
        )}
        <p className="note">
          Admin actions need an admin signed in (
          <Link href="/admin/sign-in">sign in</Link>)
          {adminEnabled() ? ", or the server's ADMIN_SECRET." : "."}
        </p>
      </section>
      <PeerAdmin />
    </>
  );
}
