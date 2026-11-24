import type { Metadata } from "next";
import { ocpiUrls } from "@/lib/server/config";
import { forEmailAdmin } from "../../ui/for-admin";
import { Connect } from "./connect";

export const metadata: Metadata = { title: "Connect a peer" };

export default async function ConnectPage() {
  // Our address goes only to an admin signed in by email.
  return (
    <Connect versionsUrl={await forEmailAdmin(() => ocpiUrls().versions)} />
  );
}
