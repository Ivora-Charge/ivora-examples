import type { Metadata } from "next";
import { ocpiUrls } from "@/lib/server/config";
import { getStatus } from "@/lib/server/status";
import { PeerList } from "./peer-list";

export const metadata: Metadata = { title: "Peers" };

export default function PeersPage() {
  const { ocpi } = getStatus();
  return (
    <PeerList
      versionsUrl={ocpiUrls().versions}
      party={`${ocpi.country_code}-${ocpi.party_id}`}
      version={ocpi.version}
    />
  );
}
