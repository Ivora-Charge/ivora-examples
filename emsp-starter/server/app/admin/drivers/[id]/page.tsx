import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { referenceFromPath } from "../reference";
import { DriverPage } from "./driver-page";

export const metadata: Metadata = { title: "Driver" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ref = referenceFromPath((await params).id);
  if (!ref) notFound();
  // Keyed: another driver starts afresh.
  return <DriverPage key={ref} driverRef={ref} />;
}
