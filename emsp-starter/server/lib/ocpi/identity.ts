import "server-only";
import { brand } from "@/brand";
import { config, OCPI_VERSION, ocpiUrls } from "@/lib/server/config";
import type { Credentials, Party, Version, VersionDetails } from "./types";

/** This eMSP as an OCPI party, from EMSP_COUNTRY_CODE and EMSP_PARTY_ID. */
export function ourParty(): Party {
  return { countryCode: config.countryCode, partyId: config.partyId };
}

/** Body of our versions endpoint. */
export function ourVersions(): Version[] {
  return [{ version: OCPI_VERSION, url: ocpiUrls().details }];
}

/**
 * Body of our version details endpoint. Later parts add the modules they implement
 * (sessions, cdrs). For commands we are the Sender: the endpoint is where CPOs POST
 * the results of the commands we send them.
 */
export function ourVersionDetails(): VersionDetails {
  const { credentials, locations, tariffs, tokens, commands } = ocpiUrls();
  return {
    version: OCPI_VERSION,
    endpoints: [
      { identifier: "credentials", role: "SENDER", url: credentials },
      { identifier: "credentials", role: "RECEIVER", url: credentials },
      { identifier: "locations", role: "RECEIVER", url: locations },
      { identifier: "tariffs", role: "RECEIVER", url: tariffs },
      { identifier: "tokens", role: "SENDER", url: tokens },
      { identifier: "commands", role: "SENDER", url: commands },
    ],
  };
}

/** Our credentials object, carrying `token` for the peer to call us with. */
export function ourCredentials(token: string): Credentials {
  const party = ourParty();
  return {
    token,
    url: ocpiUrls().versions,
    roles: [
      {
        role: "EMSP",
        business_details: { name: brand.name },
        party_id: party.partyId,
        country_code: party.countryCode,
      },
    ],
  };
}
