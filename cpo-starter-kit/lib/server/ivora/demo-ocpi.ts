import "server-only";
import { z } from "zod";
import { IvoraError } from "./errors";
import type {
  OcpiEvseIds,
  OcpiParty,
  OcpiPartyRef,
  OcpiSettings,
  OcpiSettingsInput,
} from "./types";

// The demo stand-in for Ivora's OCPI publishing settings. It keeps the visitor's
// settings (and the simulated Ivora decision on their party request) in a store,
// checks a PUT the way the API documents, and never sends anything anywhere.

/** Ivora's shared party: locations publish under it until the operator's own is approved. */
export const SHARED_PARTY: OcpiPartyRef = {
  country_code: "US",
  party_id: "IVR",
};

/** Demo: a party "another sample operator" holds, to show 409 ocpi_party_in_use. */
export const DEMO_TAKEN_PARTY: OcpiPartyRef = {
  country_code: "US",
  party_id: "ZZZ",
};

/** Clearly not a real OCPI endpoint. */
export const DEMO_VERSIONS_URL = "https://ocpi.demo.example/versions";

/** The Level 2 values Ivora uses for connectors with no hardware data. */
const LEVEL_2 = {
  standard: "IEC_62196_T1",
  format: "CABLE",
  power_type: "AC_1_PHASE",
  max_voltage: 240,
  max_amperage: 32,
};

const party = z.object({
  country_code: z.string().regex(/^[A-Z]{2}$/),
  party_id: z.string().regex(/^[A-Z0-9]{3}$/),
});

const stateSchema = z.object({
  publish: z.boolean(),
  display_name: z.string().max(100).nullable(),
  website: z.string().max(255).nullable(),
  time_zone: z.string().max(64).nullable(),
  excluded_location_ids: z.array(z.number().int().positive()).max(1000),
  own_party: party.nullable(),
  /** What the simulated Ivora staff decided. */
  approved: party.nullable(),
  rejected: party.extend({ note: z.string().max(300) }).nullable(),
  updated_at: z.string().max(40).nullable(),
});

export type DemoOcpiState = z.infer<typeof stateSchema>;

export const emptyDemoOcpi = (): DemoOcpiState => ({
  publish: false,
  display_name: null,
  website: null,
  time_zone: null,
  excluded_location_ids: [],
  own_party: null,
  approved: null,
  rejected: null,
  updated_at: null,
});

export function decodeDemoOcpi(raw: string | undefined): DemoOcpiState {
  if (!raw) return emptyDemoOcpi();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : emptyDemoOcpi();
  } catch {
    return emptyDemoOcpi();
  }
}

export function encodeDemoOcpi(s: DemoOcpiState): string {
  return Buffer.from(JSON.stringify(stateSchema.parse(s)), "utf8").toString(
    "base64url",
  );
}

export interface DemoOcpiStore {
  load(): Promise<DemoOcpiState>;
  save(s: DemoOcpiState): Promise<void>;
}

export function memoryDemoOcpi(
  initial = emptyDemoOcpi(),
): DemoOcpiStore & { state: DemoOcpiState } {
  const store = {
    state: initial,
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoOcpiState) {
      store.state = structuredClone(s);
    },
  };
  return store;
}

const same = (a: OcpiPartyRef | null, b: OcpiPartyRef | null) =>
  !!a && !!b && a.country_code === b.country_code && a.party_id === b.party_id;

/** The record the API would answer for this state. */
export function demoOcpiRecord(s: DemoOcpiState): OcpiSettings {
  const approved = same(s.own_party, s.approved);
  const used: OcpiParty =
    approved && s.own_party
      ? { ...s.own_party, shared: false }
      : { ...SHARED_PARTY, shared: true };
  return {
    publish: s.publish,
    private: false,
    published: s.publish && !!s.display_name,
    display_name: s.display_name,
    website: s.website,
    time_zone: s.time_zone,
    connector_defaults: { ...LEVEL_2 },
    excluded_location_ids: [...s.excluded_location_ids],
    own_party: s.own_party
      ? {
          ...s.own_party,
          status: approved
            ? "approved"
            : same(s.own_party, s.rejected)
              ? "rejected"
              : "pending_approval",
          rejection_note:
            !approved && same(s.own_party, s.rejected)
              ? (s.rejected?.note ?? null)
              : null,
        }
      : null,
    party: used,
    versions_url: DEMO_VERSIONS_URL,
    updated_at: s.updated_at,
  };
}

const invalid = (message: string) =>
  new IvoraError(422, "invalid_request", message);

/** Checks a PUT as the API documents it, then replaces every setting. */
export function demoPutOcpi(
  s: DemoOcpiState,
  input: OcpiSettingsInput,
  now: number,
): DemoOcpiState {
  const name = input.display_name?.trim() || null;
  if (input.publish && !name) throw invalid("publish needs a display_name");
  if (name && name.length > 100)
    throw invalid("display_name is at most 100 characters");
  if (input.website && !/^https:\/\/[^\s/@]+(\/\S*)?$/.test(input.website))
    throw invalid("website must be an https URL");
  if (input.excluded_location_ids.length > 1000)
    throw invalid("excluded_location_ids has at most 1000 IDs");
  const own = input.own_party;
  if (own && !party.safeParse(own).success)
    throw invalid(
      "own_party needs a capital ISO alpha-2 country_code and a 3-character party_id",
    );
  if (own && same(own, SHARED_PARTY))
    throw invalid("US*IVR is Ivora's shared party, not an own_party");
  if (own && same(own, DEMO_TAKEN_PARTY))
    throw new IvoraError(
      409,
      "ocpi_party_in_use",
      "Another tenant is approved for this OCPI party",
    );
  return {
    ...s,
    publish: input.publish,
    display_name: name,
    website: input.website,
    time_zone: input.time_zone,
    excluded_location_ids: [...new Set(input.excluded_location_ids)],
    own_party: own
      ? { country_code: own.country_code, party_id: own.party_id }
      : null,
    updated_at: new Date(now).toISOString(),
  };
}

/** Sample imported EVSE IDs: shown once the demo party is approved. */
export function demoOcpiEvseIds(s: DemoOcpiState): OcpiEvseIds {
  const record = demoOcpiRecord(s);
  const own = record.own_party?.status === "approved" ? record.own_party : null;
  return {
    party: record.party,
    data: own
      ? [1, 2].map((evse) => ({
          station_id: 9101,
          evse_number: evse,
          evse_id: `${own.country_code}*${own.party_id}*EDEMO0${evse}`,
          applies: true,
          updated_at: s.approved ? s.updated_at : null,
        }))
      : [],
  };
}

/**
 * Demo only: what Ivora staff would decide on the requested party. In live mode this
 * is Ivora's decision, never the operator's, and the kit has no way to make it.
 */
export function demoDecideParty(
  s: DemoOcpiState,
  decision: "approve" | "reject",
): DemoOcpiState {
  const own = s.own_party;
  if (!own) return s;
  if (decision === "approve")
    return {
      ...s,
      approved: { ...own },
      rejected: same(own, s.rejected) ? null : s.rejected,
    };
  return {
    ...s,
    approved: same(own, s.approved) ? null : s.approved,
    rejected: {
      ...own,
      note: "Demo: the registry entry did not name this operator.",
    },
  };
}
