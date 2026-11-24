import type { Metadata } from "next";
import { OCPI_VERSION, ocpiUrls } from "@/lib/server/config";
import { getStatus } from "@/lib/server/status";
import { forEmailAdmin } from "../ui/for-admin";
import { PeerList } from "./peer-list";

export const metadata: Metadata = { title: "Peers" };

export default async function PeersPage() {
  // Our address and party go only to an admin signed in by email.
  const ours = await forEmailAdmin(() => {
    const { ocpi } = getStatus();
    return {
      versionsUrl: ocpiUrls().versions,
      party: `${ocpi.country_code}-${ocpi.party_id}`,
    };
  });
  return (
    <PeerList
      versionsUrl={ours?.versionsUrl ?? null}
      party={ours?.party ?? null}
      // The OCPI version this code implements: the same on every deployment.
      version={OCPI_VERSION}
    />
  );
}
