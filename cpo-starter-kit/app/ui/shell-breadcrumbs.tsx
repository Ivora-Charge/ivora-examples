"use client";

import { usePathname } from "next/navigation";
import { crumbsFor } from "@/lib/breadcrumbs";
import { Breadcrumbs } from "./breadcrumbs";

/** Breadcrumbs for nested staff pages, from the URL; top-level pages show none. */
export default function ShellBreadcrumbs({
  sections,
}: {
  sections: { href: string; label: string }[];
}) {
  return <Breadcrumbs crumbs={crumbsFor(usePathname(), sections)} />;
}
