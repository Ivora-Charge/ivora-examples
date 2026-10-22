import "server-only";
import type { OcpiEvseId, OcpiSettings } from "../ivora/types";

export type RoamingErrorCode =
  | "invalid"
  | "stale"
  | "too_many_excluded"
  | "tenant_private"
  | "party_in_use"
  | "demo_only";

/** A problem staff can act on, with what to do next. */
export class RoamingError extends Error {
  constructor(
    public code: RoamingErrorCode,
    message: string,
    /** Every problem with the form, after the first (in message). */
    public problems: string[] = [],
  ) {
    super(message);
    this.name = "RoamingError";
  }
}

export interface RoamingSite {
  id: number;
  name: string;
  /** Not in excluded_location_ids. */
  published: boolean;
}

/** An imported EVSE ID, with its charger's name when the kit could read it. */
export interface RoamingEvseId extends OcpiEvseId {
  stationName: string | null;
}

/** What the Roaming page shows. */
export interface RoamingView {
  demo: boolean;
  settings: OcpiSettings;
  /** Pass back on save: a save over a newer change is refused. */
  revision: string;
  sites: RoamingSite[];
  /** Excluded IDs that are not among the listed sites; kept on save. */
  otherExcluded: number[];
  sitesTruncated: boolean;
  sitesError: string | null;
  evseIds: RoamingEvseId[];
  evseIdsError: string | null;
}
