import type { Metadata } from "next";
import { ocpiUrls } from "@/lib/server/config";
import { Connect } from "./connect";

export const metadata: Metadata = { title: "Connect a peer" };

export default function ConnectPage() {
  return <Connect versionsUrl={ocpiUrls().versions} />;
}
