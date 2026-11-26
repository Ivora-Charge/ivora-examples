import type { Metadata } from "next";
import { sessionSearchTerm } from "@/lib/sessions/statuses";
import { isDriverReference } from "../drivers/reference";
import { Sessions } from "./session-admin";

export const metadata: Metadata = { title: "Sessions" };

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    driver?: string | string[];
    search?: string | string[];
  }>;
}) {
  // A link from another page (a driver's page) names the driver, and maybe a session.
  const query = await searchParams;
  const driverRef = isDriverReference(query.driver) ? query.driver : "";
  const search =
    typeof query.search === "string"
      ? (sessionSearchTerm(query.search) ?? "")
      : "";
  // Keyed: another link starts the list afresh with its own filters.
  return (
    <Sessions
      key={JSON.stringify([driverRef, search])}
      prefill={{ driverRef, search }}
    />
  );
}
