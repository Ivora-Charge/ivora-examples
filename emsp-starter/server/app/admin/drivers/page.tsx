import type { Metadata } from "next";
import { isDemo } from "@/lib/server/demo";
import { DEMO_DRIVER_REF } from "@/lib/tokens/registry";
import { DriverList } from "./driver-list";

export const metadata: Metadata = { title: "Drivers" };

export default function DriversPage() {
  return <DriverList sampleDriver={isDemo() ? DEMO_DRIVER_REF : null} />;
}
