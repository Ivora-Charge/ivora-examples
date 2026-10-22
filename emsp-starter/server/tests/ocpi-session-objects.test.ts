import { describe, expect, it } from "vitest";
import {
  cdrForSession,
  sampleCdrs,
  sampleLocations,
  sampleSessions,
} from "@/lib/mock-cpo/sample-data";
import { parseCdr, parseSession } from "@/lib/ocpi/session-objects";

const CPO = { countryCode: "ZZ", partyId: "MCK" };
const EMSP = { countryCode: "NL", partyId: "ABC" };
const [session] = sampleSessions(CPO, EMSP);
const [location] = sampleLocations(CPO, 1);
const cdr = cdrForSession(session, location, {
  tariffs: [],
  total_energy_cost: { excl_vat: 19.18, incl_vat: 23.21 },
  signed_data: {
    encoding_method: "OCMF",
    signed_values: [
      { nature: "Start", plain_data: "OCMF|{}", signed_data: "c2lnbmVk" },
    ],
  },
});

describe("OCPI 2.2.1 Session", () => {
  it("accepts every sample session, upper-cases the party and drops unknown fields", () => {
    for (const s of sampleSessions(CPO, EMSP))
      expect(parseSession(s)).toEqual({ ok: true, value: s });
    const parsed = parseSession({
      ...session,
      country_code: "zz",
      party_id: "mck",
      vendor_extension: { secret: true },
    });
    expect(parsed).toEqual({ ok: true, value: session });
  });

  it.each([
    ["a negative kWh", { kwh: -0.1 }, "session.kwh"],
    ["an unknown status", { status: "CHARGING" }, "session.status"],
    ["an unknown auth method", { auth_method: "PIN" }, "session.auth_method"],
    ["a missing token", { cdr_token: undefined }, "session.cdr_token"],
    [
      "a token without a contract",
      { cdr_token: { ...session.cdr_token, contract_id: undefined } },
      "session.cdr_token.contract_id",
    ],
    ["a missing currency", { currency: undefined }, "session.currency"],
    ["a bad date", { start_date_time: "yesterday" }, "session.start_date_time"],
    [
      "an empty period",
      {
        charging_periods: [
          { start_date_time: session.start_date_time, dimensions: [] },
        ],
      },
      "session.charging_periods[0].dimensions",
    ],
    [
      "an unknown dimension",
      {
        charging_periods: [
          {
            start_date_time: session.start_date_time,
            dimensions: [{ type: "HEAT", volume: 1 }],
          },
        ],
      },
      "session.charging_periods[0].dimensions[0].type",
    ],
    ["an ID over 36 characters", { id: "S".repeat(37) }, "session.id"],
  ])("refuses %s, naming the field", (_, change, field) => {
    const parsed = parseSession({ ...session, ...change });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join(" ")).toContain(field);
      // Messages name fields, never values.
      expect(parsed.errors.join(" ")).not.toContain("CHARGING");
    }
  });
});

describe("OCPI 2.2.1 CDR", () => {
  it("accepts a full CDR and the samples", () => {
    expect(parseCdr(cdr)).toEqual({ ok: true, value: cdr });
    for (const c of sampleCdrs(CPO, sampleSessions(CPO, EMSP)))
      expect(parseCdr(c).ok).toBe(true);
  });

  it("takes a credit CDR with negative amounts, and needs its reference", () => {
    const credit = {
      ...cdr,
      id: "CREDIT-1",
      credit: true,
      credit_reference_id: cdr.id,
      total_cost: { excl_vat: -19.18, incl_vat: -23.21 },
    };
    expect(parseCdr(credit).ok).toBe(true);
    const { credit_reference_id: _, ...unreferenced } = credit;
    expect(parseCdr(unreferenced)).toEqual({
      ok: false,
      errors: ["cdr.credit_reference_id is required for a credit CDR"],
    });
  });

  it.each([
    ["no charging periods", { charging_periods: [] }, "cdr.charging_periods"],
    ["no total cost", { total_cost: undefined }, "cdr.total_cost"],
    ["a negative energy", { total_energy: -1 }, "cdr.total_energy"],
    ["no end", { end_date_time: undefined }, "cdr.end_date_time"],
    [
      "a location without its connector",
      { cdr_location: { ...cdr.cdr_location, connector_id: undefined } },
      "cdr.cdr_location.connector_id",
    ],
    ["an ID over 39 characters", { id: "C".repeat(40) }, "cdr.id"],
    [
      "an invalid tariff",
      { tariffs: [{ id: "T" }] },
      "cdr.tariffs[0]: tariff.country_code",
    ],
  ])("refuses %s, naming the field", (_, change, field) => {
    const parsed = parseCdr({ ...cdr, ...change });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toContain(field);
  });

  it("allows a 39-character CDR ID", () => {
    expect(parseCdr({ ...cdr, id: "C".repeat(39) }).ok).toBe(true);
  });
});
