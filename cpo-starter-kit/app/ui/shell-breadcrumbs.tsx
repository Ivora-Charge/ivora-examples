"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { crumbsFor } from "@/lib/breadcrumbs";
import { Breadcrumbs } from "./breadcrumbs";

type Names = Readonly<Record<string, string>>;
const SetNames = createContext<((update: (n: Names) => Names) => void) | null>(
  null,
);

/**
 * Breadcrumbs for nested staff pages, from the URL; top-level pages show none. Wraps
 * the page so a page can name its own level with `<CrumbName>`.
 */
export default function ShellBreadcrumbs({
  sections,
  children,
}: {
  sections: { href: string; label: string }[];
  children: ReactNode;
}) {
  const [names, setNames] = useState<Names>({});
  return (
    <SetNames.Provider value={setNames}>
      <Breadcrumbs crumbs={crumbsFor(usePathname(), sections, names)} />
      {children}
    </SetNames.Provider>
  );
}

/**
 * Shows `label` instead of the raw URL segment for `path` (for example a charger's
 * name for `/chargers/<key>`). Renders nothing.
 */
export function CrumbName({ path, label }: { path: string; label: string }) {
  const setNames = useContext(SetNames);
  useEffect(() => {
    if (!setNames) return;
    setNames((n) => ({ ...n, [path]: label }));
    return () =>
      setNames((n) => {
        const { [path]: _gone, ...rest } = n;
        return rest;
      });
  }, [setNames, path, label]);
  return null;
}
