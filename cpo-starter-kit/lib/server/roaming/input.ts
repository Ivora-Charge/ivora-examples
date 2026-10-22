import "server-only";
import { z } from "zod";
import type { OcpiPartyRef } from "../ivora/types";

// The Roaming form, checked as the API checks PUT /ocpi, so staff see every problem
// before anything is sent. The API checks again.

/** What the form posts. Location IDs are the sites the page listed. */
export interface RoamingForm {
  publish?: string;
  displayName?: string;
  website?: string;
  timeZone?: string;
  countryCode?: string;
  partyId?: string;
  /** The settings' updated_at when the page was loaded; a stale save is refused. */
  revision?: string;
  /** Every site the page listed. */
  shownLocations: string[];
  /** The listed sites left ticked ("publish this site"). */
  publishedLocations: string[];
}

export interface RoamingInput {
  publish: boolean;
  displayName: string | null;
  website: string | null;
  timeZone: string | null;
  ownParty: OcpiPartyRef | null;
  revision: string;
  shownLocations: number[];
  publishedLocations: number[];
}

const blank = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/** IANA zones as the API takes them: Region/City (so not plain UTC), and one the runtime knows. */
export function knownZone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ids = z
  .array(z.string().regex(/^\d{1,10}$/, "Unknown site"))
  .max(5000, "Too many sites")
  .transform((a) => [...new Set(a.map(Number))]);

const schema = z
  .object({
    publish: z.boolean(),
    displayName: z
      .string()
      .max(100, "Operator name: at most 100 characters")
      .nullable(),
    website: z
      .string()
      .max(255, "Website: at most 255 characters")
      .regex(
        /^https:\/\/[^\s/@]+(\/\S*)?$/,
        "Website: a full https:// address, for example https://charge.example.com",
      )
      .nullable(),
    timeZone: z
      .string()
      .max(64)
      .refine(
        knownZone,
        "Time zone: an IANA zone with a region, for example America/Chicago",
      )
      .nullable(),
    countryCode: z
      .string()
      .regex(
        /^[A-Z]{2}$/,
        "Country code: the two letters of the registry's country (ISO 3166), for example US",
      )
      .nullable(),
    partyId: z
      .string()
      .regex(
        /^[A-Z0-9]{3}$/,
        "Party ID: the three letters or digits the registry issued",
      )
      .nullable(),
    revision: z.string().max(40),
    shownLocations: ids,
    publishedLocations: ids,
  })
  .superRefine((v, ctx) => {
    if (v.publish && !v.displayName)
      ctx.addIssue({
        code: "custom",
        message: "Operator name: needed to publish (partners show it)",
      });
    if (!!v.countryCode !== !!v.partyId)
      ctx.addIssue({
        code: "custom",
        message:
          "Party ID: fill in both the country code and the party ID, or leave both empty",
      });
    if (v.countryCode === "US" && v.partyId === "IVR")
      ctx.addIssue({
        code: "custom",
        message:
          "Party ID: US*IVR is Ivora's shared party. Leave both fields empty to use it",
      });
  });

/** Every problem, in form order; empty when the form is fine. */
export function parseRoamingForm(
  f: RoamingForm,
): { ok: true; value: RoamingInput } | { ok: false; problems: string[] } {
  const r = schema.safeParse({
    publish: f.publish === "on",
    displayName: blank(f.displayName),
    website: blank(f.website),
    timeZone: blank(f.timeZone),
    countryCode: blank(f.countryCode)?.toUpperCase() ?? null,
    partyId: blank(f.partyId)?.toUpperCase() ?? null,
    revision: f.revision ?? "",
    shownLocations: f.shownLocations,
    publishedLocations: f.publishedLocations,
  });
  if (!r.success)
    return { ok: false, problems: r.error.issues.map((i) => i.message) };
  const v = r.data;
  return {
    ok: true,
    value: {
      publish: v.publish,
      displayName: v.displayName,
      website: v.website,
      timeZone: v.timeZone,
      ownParty:
        v.countryCode && v.partyId
          ? { country_code: v.countryCode, party_id: v.partyId }
          : null,
      revision: v.revision,
      shownLocations: v.shownLocations,
      publishedLocations: v.publishedLocations,
    },
  };
}
