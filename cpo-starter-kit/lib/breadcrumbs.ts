export interface Crumb {
  label: string;
  /** Absent on the current page. */
  href?: string;
}

/** Path segments that have no page of their own, so no crumb. */
const NO_PAGE = new Set(["stations"]);

const SEGMENT_LABELS: Record<string, string> = {
  new: "New",
  stickers: "Stickers",
  roaming: "Roaming",
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function segmentLabel(segment: string): string {
  return SEGMENT_LABELS[segment] ?? decode(segment);
}

/**
 * The trail for a staff page: the section, then each level below it. Top-level pages
 * return no trail (the sidebar already says where you are); the last crumb is the
 * current page and has no link. `names` gives a readable label for a path a page
 * knows more about (a charger's name instead of its key), keyed by the decoded path.
 */
export function crumbsFor(
  pathname: string,
  sections: { href: string; label: string }[],
  names: Readonly<Record<string, string>> = {},
): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [];
  const section = sections.find((s) => s.href === `/${segments[0]}`);
  if (!section) return [];
  const crumbs: Crumb[] = [{ label: section.label, href: section.href }];
  let path = section.href;
  for (const segment of segments.slice(1)) {
    path += `/${segment}`;
    if (NO_PAGE.has(segment)) continue;
    crumbs.push({
      label: names[decode(path)] ?? segmentLabel(segment),
      href: path,
    });
  }
  const last = crumbs.at(-1)!;
  if (crumbs.length < 2) return [];
  crumbs[crumbs.length - 1] = { label: last.label };
  return crumbs;
}
