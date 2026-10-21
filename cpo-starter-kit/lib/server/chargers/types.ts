import "server-only";
import type { Staff } from "../team/types";

/** A site to create in Ivora with the charger (kept until the location exists). */
export interface NewSite {
  name: string;
  address: string;
  city: string;
  postalCode: string;
  /** Three letters, for example USA. */
  country: string;
}

/** The connection test: read-only checks of the station Ivora reports. */
export interface ConnectionTest {
  at: string;
  online: boolean;
  /** The charger sent a BootNotification (vendor or model is known). */
  booted: boolean;
  /** Its last OCPP message (a heartbeat or anything else) is recent. */
  heartbeat: boolean;
  lastSeen: string | null;
  passed: boolean;
}

/** A test in one of these phases may have started the charger. */
export const RUNNING_PHASES: readonly RemoteTest["phase"][] = [
  "starting",
  "charging",
  "stopping",
];

/** The optional remote start and stop test. */
export interface RemoteTest {
  attempt: number;
  phase: "starting" | "charging" | "stopping" | "passed" | "failed";
  connectorNumber: number;
  /** Ivora's connector resource ID. */
  connectorId: number;
  requestedAt: string;
  transactionId: number | null;
  /** Operation of the start or stop, while the charger has not answered yet. */
  operationId: string | null;
  energyWh: number;
  finishedAt: string | null;
  error: string | null;
}

export interface StickerCode {
  code: string;
  connectorNumber: number;
  connectorId: number | null;
}

/** The kit's own record of a charger. Ivora keeps the station; this keeps our side. */
export interface ChargerRecord {
  /** Our ID: the external_reference is cpo-charger-<id>, and keys derive from it. */
  id: string;
  /** Null until Ivora has registered the station. */
  stationId: number | null;
  /** The OCPP connection name. */
  name: string;
  /** The kit's own display name. */
  label: string | null;
  locationId: number | null;
  newSite: NewSite | null;
  connectors: number;
  connectionUrl: string | null;
  passwordSetAt: string | null;
  connectionTest: ConnectionTest | null;
  remoteTest: RemoteTest | null;
  codes: StickerCode[];
  createdAt: string;
  removedAt: string | null;
}

export interface NewChargerRecord {
  name: string;
  label: string | null;
  locationId: number | null;
  newSite: NewSite | null;
  connectors: number;
  /** Set when the kit takes over a station that is already in Ivora. */
  stationId: number | null;
  connectionUrl: string | null;
}

export type ChargerChanges = Partial<
  Pick<
    ChargerRecord,
    | "label"
    | "locationId"
    | "newSite"
    | "stationId"
    | "connectionUrl"
    | "passwordSetAt"
    | "connectionTest"
    | "remoteTest"
  >
>;

/** What a sticker code leads to, for the public /c/<code> page. */
export interface ResolvedCode {
  code: string;
  connectorNumber: number;
  chargerName: string;
  /** False once the charger was removed from the kit. */
  inService: boolean;
  operatorName: string | null;
}

/**
 * Where the kit's charger records are kept. The Supabase store calls database
 * functions that check the actor's role in the same statement as the write; the demo
 * store keeps them in the visitor's cookie and sends nothing anywhere.
 */
export interface ChargerStore {
  readonly mode: "live" | "demo";
  /** Every record of the operator, removed ones included. */
  list(operatorId: string): Promise<ChargerRecord[]>;
  create(actor: Staff, r: NewChargerRecord): Promise<string>;
  update(actor: Staff, id: string, changes: ChargerChanges): Promise<void>;
  /** The next number for an Idempotency-Key, counted atomically. */
  nextSeq(
    actor: Staff,
    id: string,
    kind: "credentials" | "edit",
  ): Promise<number>;
  /**
   * Claims the remote test in one atomic step: unless a test is running on the
   * charger (ChargerError "busy"), counts the next attempt and records `test` as it.
   * Returns the attempt, which goes into the start command's Idempotency-Key.
   */
  claimTest(
    actor: Staff,
    id: string,
    test: Omit<RemoteTest, "attempt">,
  ): Promise<number>;
  /** Adds codes for connectors that have none; a taken code is skipped. */
  addCodes(actor: Staff, id: string, codes: StickerCode[]): Promise<void>;
  /** Managers and owners only, except for a record Ivora never registered. */
  remove(actor: Staff, id: string): Promise<void>;
  resolveCode(code: string): Promise<ResolvedCode | null>;
}

export type ChargerErrorCode =
  | "invalid"
  | "not_allowed"
  | "not_found"
  | "exists"
  | "not_ready"
  | "busy"
  | "unconfirmed";

/** An error staff can act on. The message is safe to show. */
export class ChargerError extends Error {
  constructor(
    public code: ChargerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChargerError";
  }
}

export const notAllowed = (what = "work on chargers") =>
  new ChargerError(
    "not_allowed",
    `Your role can't ${what}. If your role just changed, reload the page.`,
  );

export const testBusy = () =>
  new ChargerError(
    "busy",
    "A test is already running on this charger. Check it or stop it first.",
  );

export const notFound = () =>
  new ChargerError(
    "not_found",
    "That charger is not in the kit (it may have been removed). Reload the page.",
  );
