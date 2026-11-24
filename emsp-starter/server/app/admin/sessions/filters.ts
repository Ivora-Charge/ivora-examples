/** The status filters of the session list; "live" is ACTIVE, PENDING or RESERVATION. */
export const STATUS_FILTERS = [
  "live",
  "all",
  "ACTIVE",
  "PENDING",
  "RESERVATION",
  "COMPLETED",
  "INVALID",
] as const;

/** The statuses a "live" list covers (the same as lib/sessions/store.ts). */
export const OPEN_SESSION_STATUSES = ["ACTIVE", "PENDING", "RESERVATION"];
