import type { Metadata } from "next";
import { Sessions } from "./session-admin";

export const metadata: Metadata = { title: "Sessions" };

export default function SessionsPage() {
  return <Sessions />;
}
