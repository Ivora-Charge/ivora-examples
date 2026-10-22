import type {
  Connector,
  Evse,
  EvseStatus,
  Location,
  ParkingRestriction,
} from "@/lib/ocpi/locations";
import type {
  Amount,
  Cdr,
  CdrToken,
  Session,
} from "@/lib/ocpi/session-objects";
import type { Tariff } from "@/lib/ocpi/tariffs";
import { ocpiTimestamp, type Party } from "@/lib/ocpi/types";

/**
 * Sample OCPI 2.2.1 locations, tariffs, sessions and CDRs of a made-up CPO: the mock
 * CPO serves them, and demo mode shows them. Sites, streets and the city are invented. Together they
 * cover what the search and the price display handle: AC and DC, several connector
 * standards, every EVSE state that matters (available, charging, out of order, planned,
 * removed), facilities, parking restrictions, an unpublished site, and free, energy,
 * time-of-day, idle-fee, parking and flat-fee tariffs.
 */
export type SampleOptions = {
  /** Where the sites are. Default: a point in central Europe. */
  center?: { lat: number; lng: number };
  city?: string;
  /** ISO 3166-1 alpha-3. */
  country?: string;
  timeZone?: string;
  currency?: string;
  lastUpdated?: string;
};

const DEFAULTS = {
  center: { lat: 52.09074, lng: 5.12142 },
  city: "Sample City",
  country: "NLD",
  timeZone: "Europe/Amsterdam",
  currency: "EUR",
  lastUpdated: "2026-10-01T00:00:00Z",
};

type ConnectorSpec = Pick<
  Connector,
  "standard" | "format" | "power_type" | "max_voltage" | "max_amperage"
> & { kw: number };

const CCS_150: ConnectorSpec = {
  standard: "IEC_62196_T2_COMBO",
  format: "CABLE",
  power_type: "DC",
  max_voltage: 920,
  max_amperage: 200,
  kw: 150,
};
const CCS_300: ConnectorSpec = { ...CCS_150, max_amperage: 500, kw: 300 };
const CHADEMO_50: ConnectorSpec = {
  standard: "CHADEMO",
  format: "CABLE",
  power_type: "DC",
  max_voltage: 500,
  max_amperage: 125,
  kw: 50,
};
const T2_22: ConnectorSpec = {
  standard: "IEC_62196_T2",
  format: "SOCKET",
  power_type: "AC_3_PHASE",
  max_voltage: 230,
  max_amperage: 32,
  kw: 22,
};
const T2_11: ConnectorSpec = { ...T2_22, max_amperage: 16, kw: 11 };
const T2_7: ConnectorSpec = {
  ...T2_22,
  power_type: "AC_1_PHASE",
  kw: 7.4,
};

type EvseSpec = {
  status: EvseStatus;
  connectors: ConnectorSpec[];
  tariffs: string[];
  parking?: ParkingRestriction[];
  floor?: string;
};

type Site = {
  name: string;
  address: string;
  postal: string;
  offset: [number, number];
  publish?: boolean;
  parking_type: Location["parking_type"];
  facilities: Location["facilities"];
  opening_times?: Location["opening_times"];
  evses: EvseSpec[];
};

const SITES: Site[] = [
  {
    name: "Station Square",
    address: "1 Station Square",
    postal: "1000 AA",
    offset: [0.002, 0.004],
    parking_type: "PARKING_LOT",
    facilities: ["TRAIN_STATION", "CAFE"],
    evses: [
      {
        status: "AVAILABLE",
        connectors: [CCS_150, CHADEMO_50],
        tariffs: ["DC_FAST"],
      },
      { status: "CHARGING", connectors: [CCS_150], tariffs: ["DC_FAST"] },
    ],
  },
  {
    name: "Market Hall",
    address: "12 Market Street",
    postal: "1000 AB",
    offset: [-0.006, 0.01],
    parking_type: "PARKING_LOT",
    facilities: ["SUPERMARKET", "WIFI"],
    evses: [
      { status: "AVAILABLE", connectors: [T2_22], tariffs: ["AC_DAY_NIGHT"] },
      {
        status: "AVAILABLE",
        connectors: [T2_22],
        tariffs: ["AC_DAY_NIGHT"],
        parking: ["CUSTOMERS"],
      },
      { status: "OUTOFORDER", connectors: [T2_22], tariffs: ["AC_DAY_NIGHT"] },
    ],
  },
  {
    name: "Town Hall Garage",
    address: "3 Garden Lane",
    postal: "1000 AC",
    offset: [0.01, -0.008],
    parking_type: "UNDERGROUND_GARAGE",
    facilities: ["PARKING_LOT"],
    opening_times: {
      twentyfourseven: false,
      regular_hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        period_begin: "07:00",
        period_end: "23:00",
      })),
    },
    evses: [
      {
        status: "AVAILABLE",
        connectors: [T2_11],
        tariffs: ["AC_PARKING"],
        parking: ["DISABLED", "EV_ONLY"],
        floor: "-1",
      },
      {
        status: "CHARGING",
        connectors: [T2_11],
        tariffs: ["AC_PARKING"],
        floor: "-1",
      },
    ],
  },
  {
    name: "Riverside Park",
    address: "40 River Walk",
    postal: "1000 AD",
    offset: [-0.015, -0.02],
    parking_type: "ON_STREET",
    facilities: ["NATURE", "RECREATION_AREA"],
    evses: [{ status: "AVAILABLE", connectors: [T2_7], tariffs: ["FREE"] }],
  },
  {
    name: "Motorway Services North",
    address: "Motorway A1, exit 7",
    postal: "1001 AA",
    offset: [0.08, 0.05],
    parking_type: "ALONG_MOTORWAY",
    facilities: ["FUEL_STATION", "RESTAURANT", "WIFI"],
    evses: [
      {
        status: "AVAILABLE",
        connectors: [CCS_300],
        tariffs: ["HPC", "HPC_ADHOC"],
      },
      {
        status: "AVAILABLE",
        connectors: [CCS_300],
        tariffs: ["HPC", "HPC_ADHOC"],
      },
      { status: "PLANNED", connectors: [CCS_300], tariffs: ["HPC"] },
      { status: "REMOVED", connectors: [CCS_150], tariffs: ["HPC"] },
    ],
  },
  {
    name: "Fleet Depot",
    address: "8 Depot Road",
    postal: "1000 AE",
    offset: [0.001, 0.001],
    publish: false,
    parking_type: "PARKING_LOT",
    facilities: [],
    evses: [{ status: "AVAILABLE", connectors: [T2_22], tariffs: ["FREE"] }],
  },
];

/** How many sample sites there are before they repeat. */
export const SAMPLE_SITE_COUNT = SITES.length;

const coord = (n: number) => n.toFixed(6);

/** `count` sample locations of `party`, with IDs LOC1, LOC2 and so on. */
export function sampleLocations(
  party: Party,
  count = SITES.length,
  options: SampleOptions = {},
): Location[] {
  const o = { ...DEFAULTS, ...options };
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const site = SITES[i % SITES.length];
    const round = Math.floor(i / SITES.length);
    const id = `LOC${n}`;
    const ref = n <= 26 ? String.fromCharCode(64 + n) : `${n}-`;
    const evses: Evse[] = site.evses.map((e, k) => {
      const evse: Evse = {
        uid: `${id}-${k + 1}`,
        evse_id: `${party.countryCode}*${party.partyId}*E${n}${k + 1}`,
        status: e.status,
        capabilities: ["RFID_READER", "REMOTE_START_STOP_CAPABLE"],
        connectors: e.connectors.map((c, j) => ({
          id: String(j + 1),
          standard: c.standard,
          format: c.format,
          power_type: c.power_type,
          max_voltage: c.max_voltage,
          max_amperage: c.max_amperage,
          max_electric_power: Math.round(c.kw * 1000),
          tariff_ids: e.tariffs,
          last_updated: o.lastUpdated,
        })),
        physical_reference: `${ref}${k + 1}`,
        last_updated: o.lastUpdated,
      };
      if (e.parking) evse.parking_restrictions = e.parking;
      if (e.floor) evse.floor_level = e.floor;
      return evse;
    });
    const location: Location = {
      country_code: party.countryCode,
      party_id: party.partyId,
      id,
      publish: site.publish ?? true,
      name: round ? `${site.name} ${round + 1}` : site.name,
      address: site.address,
      city: o.city,
      postal_code: site.postal,
      country: o.country,
      coordinates: {
        latitude: coord(o.center.lat + site.offset[0] + round * 0.003),
        longitude: coord(o.center.lng + site.offset[1] + round * 0.003),
      },
      parking_type: site.parking_type,
      evses,
      operator: { name: "Sample Charging Operator" },
      facilities: site.facilities,
      time_zone: o.timeZone,
      last_updated: o.lastUpdated,
    };
    if (site.opening_times) location.opening_times = site.opening_times;
    else location.opening_times = { twentyfourseven: true };
    return location;
  });
}

/** The tariffs the sample locations refer to. */
export function sampleTariffs(
  party: Party,
  options: SampleOptions = {},
): Tariff[] {
  const o = { ...DEFAULTS, ...options };
  const base = {
    country_code: party.countryCode,
    party_id: party.partyId,
    currency: o.currency,
    last_updated: o.lastUpdated,
  };
  return [
    {
      ...base,
      id: "DC_FAST",
      type: "REGULAR",
      tariff_alt_text: [
        {
          language: "en",
          text: "0.59 per kWh. After 45 minutes, 6.00 per hour.",
        },
      ],
      elements: [
        {
          price_components: [
            { type: "ENERGY", price: 0.59, vat: 21, step_size: 1 },
          ],
        },
        {
          price_components: [
            { type: "TIME", price: 6, vat: 21, step_size: 60 },
          ],
          restrictions: { min_duration: 2700 },
        },
      ],
    },
    {
      ...base,
      id: "AC_DAY_NIGHT",
      elements: [
        {
          price_components: [
            { type: "FLAT", price: 0.5, vat: 21, step_size: 1 },
          ],
        },
        {
          price_components: [
            { type: "ENERGY", price: 0.39, vat: 21, step_size: 1 },
          ],
          restrictions: {
            start_time: "07:00",
            end_time: "21:00",
            day_of_week: [
              "MONDAY",
              "TUESDAY",
              "WEDNESDAY",
              "THURSDAY",
              "FRIDAY",
            ],
          },
        },
        {
          price_components: [
            { type: "ENERGY", price: 0.29, vat: 21, step_size: 1 },
          ],
        },
      ],
    },
    {
      ...base,
      id: "AC_PARKING",
      elements: [
        {
          price_components: [
            { type: "ENERGY", price: 0.35, vat: 21, step_size: 1 },
            { type: "PARKING_TIME", price: 2, vat: 21, step_size: 300 },
          ],
        },
      ],
    },
    {
      ...base,
      id: "FREE",
      elements: [
        {
          price_components: [{ type: "ENERGY", price: 0, step_size: 1 }],
        },
      ],
    },
    {
      ...base,
      id: "HPC",
      type: "REGULAR",
      min_price: { excl_vat: 1, incl_vat: 1.21 },
      elements: [
        {
          price_components: [
            { type: "ENERGY", price: 0.69, vat: 21, step_size: 1 },
          ],
        },
      ],
    },
    {
      ...base,
      id: "HPC_ADHOC",
      type: "AD_HOC_PAYMENT",
      elements: [
        {
          price_components: [
            { type: "ENERGY", price: 0.79, vat: 21, step_size: 1 },
          ],
        },
      ],
    },
  ];
}

/** The token of a sample driver of `emsp`, as a session or CDR names it. */
export function sampleCdrToken(emsp: Party, n = 1): CdrToken {
  const digits = String(n).padStart(8, "0");
  return {
    country_code: emsp.countryCode,
    party_id: emsp.partyId,
    uid: `SAMPLE${digits}`,
    type: "APP_USER",
    contract_id: `${emsp.countryCode}${emsp.partyId}C${digits}`,
  };
}

const plus = (iso: string, minutes: number) =>
  ocpiTimestamp(new Date(Date.parse(iso) + minutes * 60_000));

/**
 * Three sample sessions of `cpo` for drivers of `emsp`, at the first three sample
 * locations: S1 completed (it has a CDR, sampleCdrs), S2 completed with no CDR yet, and
 * S3 still charging.
 */
export function sampleSessions(
  cpo: Party,
  emsp: Party,
  options: SampleOptions = {},
): Session[] {
  const o = { ...DEFAULTS, ...options };
  const t0 = o.lastUpdated;
  const base = {
    country_code: cpo.countryCode,
    party_id: cpo.partyId,
    auth_method: "COMMAND" as const,
    connector_id: "1",
    currency: o.currency,
  };
  return [
    {
      ...base,
      id: "S1",
      start_date_time: plus(t0, -180),
      end_date_time: plus(t0, -140),
      kwh: 32.5,
      cdr_token: sampleCdrToken(emsp, 1),
      location_id: "LOC1",
      evse_uid: "LOC1-1",
      charging_periods: [
        {
          start_date_time: plus(t0, -180),
          dimensions: [{ type: "ENERGY", volume: 32.5 }],
          tariff_id: "DC_FAST",
        },
      ],
      total_cost: { excl_vat: 19.18, incl_vat: 23.21 },
      status: "COMPLETED",
      last_updated: plus(t0, -139),
    },
    {
      ...base,
      id: "S2",
      start_date_time: plus(t0, -120),
      end_date_time: plus(t0, -60),
      kwh: 11,
      cdr_token: sampleCdrToken(emsp, 2),
      location_id: "LOC2",
      evse_uid: "LOC2-1",
      total_cost: { excl_vat: 4.29, incl_vat: 5.19 },
      status: "COMPLETED",
      last_updated: plus(t0, -59),
    },
    {
      ...base,
      id: "S3",
      start_date_time: plus(t0, -20),
      kwh: 4.2,
      cdr_token: sampleCdrToken(emsp, 3),
      location_id: "LOC3",
      evse_uid: "LOC3-1",
      status: "ACTIVE",
      last_updated: plus(t0, -1),
    },
  ];
}

/**
 * A CDR for `session`, as its CPO would send it once it is over: the location, EVSE and
 * connector from `location`, the session's energy, time, periods and cost.
 */
export function cdrForSession(
  session: Session,
  location: Location,
  over: Partial<Cdr> & { totalCost?: Amount } = {},
): Cdr {
  const evse =
    location.evses?.find((e) => e.uid === session.evse_uid) ??
    location.evses![0];
  const connector =
    evse.connectors.find((c) => c.id === session.connector_id) ??
    evse.connectors[0];
  const end = session.end_date_time ?? session.last_updated;
  const { totalCost, ...rest } = over;
  return {
    country_code: session.country_code,
    party_id: session.party_id,
    id: `CDR-${session.id}`,
    start_date_time: session.start_date_time,
    end_date_time: end,
    session_id: session.id,
    cdr_token: session.cdr_token,
    auth_method: session.auth_method,
    ...(session.authorization_reference
      ? { authorization_reference: session.authorization_reference }
      : {}),
    cdr_location: {
      id: location.id,
      ...(location.name ? { name: location.name } : {}),
      address: location.address,
      city: location.city,
      ...(location.postal_code ? { postal_code: location.postal_code } : {}),
      country: location.country,
      coordinates: location.coordinates,
      evse_uid: evse.uid,
      evse_id: evse.evse_id ?? evse.uid,
      connector_id: connector.id,
      connector_standard: connector.standard,
      connector_format: connector.format,
      connector_power_type: connector.power_type,
    },
    currency: session.currency,
    charging_periods: session.charging_periods?.length
      ? session.charging_periods
      : [
          {
            start_date_time: session.start_date_time,
            dimensions: [{ type: "ENERGY", volume: session.kwh }],
          },
        ],
    total_cost: totalCost ?? session.total_cost ?? { excl_vat: 0 },
    total_energy: session.kwh,
    total_time:
      Math.round(
        ((Date.parse(end) - Date.parse(session.start_date_time)) / 3_600_000) *
          10_000,
      ) / 10_000,
    last_updated: end,
    ...rest,
  };
}

/** The sample CDRs: one, for the first sample session. */
export function sampleCdrs(
  cpo: Party,
  sessions: Session[],
  options: SampleOptions = {},
): Cdr[] {
  const locations = sampleLocations(cpo, 3, options);
  const s1 = sessions.find((s) => s.id === "S1")!;
  return [
    cdrForSession(
      s1,
      locations.find((l) => l.id === s1.location_id)!,
    ),
  ];
}
