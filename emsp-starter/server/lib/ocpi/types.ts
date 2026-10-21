/** OCPI 2.2.1 objects used by the versions and credentials modules. */

export const ROLES = [
  "CPO",
  "EMSP",
  "HUB",
  "NAP",
  "NSP",
  "OTHER",
  "SCSP",
] as const;
export type Role = (typeof ROLES)[number];

export type InterfaceRole = "SENDER" | "RECEIVER";

export type Image = {
  url: string;
  thumbnail?: string;
  category: string;
  type: string;
  width?: number;
  height?: number;
};

export type BusinessDetails = { name: string; website?: string; logo?: Image };

export type CredentialsRole = {
  role: Role;
  business_details: BusinessDetails;
  party_id: string;
  country_code: string;
};

export type Credentials = {
  token: string;
  url: string;
  roles: CredentialsRole[];
};

export type Version = { version: string; url: string };

export type Endpoint = {
  identifier: string;
  role: InterfaceRole;
  url: string;
};

export type VersionDetails = { version: string; endpoints: Endpoint[] };

/** Every OCPI response body. */
export type Envelope<T = unknown> = {
  data?: T;
  status_code: number;
  status_message?: string;
  timestamp: string;
};

/** An OCPI party: country code and party ID, upper case. */
export type Party = { countryCode: string; partyId: string };

/** OCPI 2.2.1 status codes (section 5). */
export const STATUS = {
  SUCCESS: 1000,
  CLIENT_ERROR: 2000,
  INVALID_PARAMETERS: 2001,
  NOT_ENOUGH_INFORMATION: 2002,
  UNKNOWN_LOCATION: 2003,
  UNKNOWN_TOKEN: 2004,
  SERVER_ERROR: 3000,
  UNABLE_TO_USE_CLIENT_API: 3001,
  UNSUPPORTED_VERSION: 3002,
  NO_MATCHING_ENDPOINTS: 3003,
  HUB_ERROR: 4000,
  UNKNOWN_RECEIVER: 4001,
  TIMEOUT_ON_FORWARDED_REQUEST: 4002,
  CONNECTION_PROBLEM: 4003,
} as const;

/** OCPI DateTime: RFC 3339 in UTC, without fractional seconds. */
export function ocpiTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const sameParty = (a: Party, b: Party) =>
  a.countryCode.toUpperCase() === b.countryCode.toUpperCase() &&
  a.partyId.toUpperCase() === b.partyId.toUpperCase();
