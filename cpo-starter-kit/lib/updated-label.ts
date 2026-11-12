const hhmmss = (iso: string, zone: string | null) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: zone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(iso));

/**
 * "14:03:22 GMT-5 (19:03:22 UTC)": the time in the company's time zone, UTC second.
 * Without a zone (not set, or not one the runtime knows) just "19:03:22 UTC".
 */
export function updatedLabel(iso: string, zone: string | null): string {
  const utc = `${iso.slice(11, 19)} UTC`;
  if (!zone || zone === "UTC" || Number.isNaN(Date.parse(iso))) return utc;
  try {
    return `${hhmmss(iso, zone)} (${utc})`;
  } catch {
    return utc;
  }
}
