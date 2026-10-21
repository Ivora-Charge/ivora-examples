import "server-only";
import { brand } from "@/brand";
import { publicSummary } from "./config";
import { mode, type Mode } from "./demo";

/** Body of `GET /api/v1/status`, read by the driver app. Contains no secrets. */
export type Status = {
  mode: Mode;
  name: string;
  ocpi: { version: string; country_code: string; party_id: string };
};

export function getStatus(): Status {
  const s = publicSummary();
  return {
    mode: mode(),
    name: brand.name,
    ocpi: {
      version: s.ocpiVersion,
      country_code: s.countryCode,
      party_id: s.partyId,
    },
  };
}
