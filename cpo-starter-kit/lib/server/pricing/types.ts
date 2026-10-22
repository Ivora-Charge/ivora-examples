import "server-only";
import type { DayOfWeek } from "../ivora/types";
import type { Staff } from "../team/types";

/** A time-of-use period: a different per-kWh price on some days and hours. */
export interface TouPeriod {
  /** At least one day. All seven means every day. */
  days: DayOfWeek[];
  /** HH:MM local time, inclusive. */
  start: string;
  /** HH:MM local time, exclusive; before `start` wraps past midnight. */
  end: string;
  energyMinorPerKwh: number;
}

/**
 * One version of a tariff as the kit's editor describes it. The kit turns it into
 * OCPI 2.2.1-aligned Ivora elements (lib/server/pricing/tariff.ts); money is integer
 * minor units of `currency`.
 */
export interface TariffDefinition {
  /** free: zero price and no card hold. */
  kind: "paid" | "free";
  /** ISO 4217. */
  currency: string;
  /** IANA time zone the periods' local times are in. */
  timeZone: string;
  /** The base per-kWh price, outside any period. */
  energyMinorPerKwh: number;
  /** Optional fee per session (0 for none). */
  sessionFeeMinor: number;
  /**
   * Idle fee per minute a car is plugged in but not charging (0 for none). Ivora bills
   * it as PARKING_TIME: after charging ends, and while charging is paused.
   */
  idleMinorPerMinute: number;
  /**
   * Idle minutes per session that are free, before the idle fee starts. Ivora applies
   * them (rules.idle_grace_minutes); the kit only offers them once Ivora's simulation
   * shows it does (see README).
   */
  idleGraceMinutes: number;
  periods: TouPeriod[];
  /** The operator's own words for drivers; null uses the kit's generated text. */
  driverText: string | null;
}

export interface TariffVersion {
  version: number;
  /** Ivora's tariff for this version; null while its creation is unconfirmed. */
  ivoraTariffId: number | null;
  /** The create request's attempt, part of its Idempotency-Key. */
  attempt: number;
  /**
   * When the latest create attempt was started. Discarding waits until it can no
   * longer be in flight (see DISCARD_WAIT_SECONDS).
   */
  attemptedAt: string;
  /** Null for older versions the demo no longer keeps in its cookie. */
  definition: TariffDefinition | null;
  createdAt: string;
  /** When Ivora archived this version's tariff after a newer one replaced it. */
  archivedAt: string | null;
}

/** One of the operator's tariffs. Each change is a new version; bills keep theirs. */
export interface KitTariff {
  /** Our ID: Ivora references and keys derive from it (cpo-tariff-<id>-v<n>). */
  id: string;
  name: string;
  /**
   * Moves with every new, dropped or discarded version. A save names the revision its
   * editor was loaded at and is refused ("changed") if it moved meanwhile.
   */
  revision: number;
  /** Newest first. Numbers are never reused, so there may be gaps. */
  versions: TariffVersion[];
}

/** Station-level pricing: its tariff, private access, and per-connector overrides. */
export interface StationPricing {
  stationId: number;
  /** The kit tariff for the whole station; null for none. */
  tariffId: string | null;
  /** No public QR checkout: staff and RFID only. */
  private: boolean;
  /** Connector resource ID to kit tariff ID, where a connector differs. */
  connectors: Record<string, string>;
  /** Moves with every save; 0 before the first. A save names the one it was loaded at. */
  revision: number;
}

export interface PricingState {
  tariffs: KitTariff[];
  stations: StationPricing[];
}

export interface StationPricingInput {
  tariffId: string | null;
  private: boolean;
  /** Overrides by connector resource ID; connectors not listed use the station's. */
  connectors: { connectorId: number; tariffId: string }[];
}

/**
 * Where the kit keeps tariffs and assignments. The Supabase store calls database
 * functions that check the actor is an owner or manager in the same statement as the
 * write; the demo store keeps them in the visitor's cookie and sends nothing anywhere.
 */
export interface PricingStore {
  readonly mode: "live" | "demo";
  load(operatorId: string): Promise<PricingState>;
  /** A new tariff with its first version, not yet in Ivora. */
  createTariff(
    actor: Staff,
    name: string,
    definition: TariffDefinition,
  ): Promise<string>;
  /**
   * The next version, not yet in Ivora. Refused ("changed") unless the tariff is still
   * at `expectedRevision`, and ("busy") while an earlier version's creation is still
   * unconfirmed.
   */
  addVersion(
    actor: Staff,
    tariffId: string,
    expectedRevision: number,
    name: string,
    definition: TariffDefinition,
  ): Promise<number>;
  /** A new create attempt for an unconfirmed version; returns its number. */
  nextAttempt(actor: Staff, tariffId: string, version: number): Promise<number>;
  /** Ivora created the version's tariff. */
  recordVersion(
    actor: Staff,
    tariffId: string,
    version: number,
    ivoraTariffId: number,
  ): Promise<void>;
  /**
   * Ivora definitely refused the version, or staff discarded it and Ivora has no live
   * tariff for it: forget it (and a tariff left with none).
   */
  dropVersion(actor: Staff, tariffId: string, version: number): Promise<void>;
  /** Ivora archived the version's tariff. */
  recordArchived(
    actor: Staff,
    tariffId: string,
    version: number,
  ): Promise<void>;
  /**
   * Replaces the station's pricing and connector overrides in one step. Refused
   * ("changed") unless the station is still at `expectedRevision` (0: never saved).
   */
  setStation(
    actor: Staff,
    stationId: number,
    expectedRevision: number,
    input: StationPricingInput,
  ): Promise<void>;
}

export type PricingErrorCode =
  "invalid" | "not_allowed" | "not_found" | "busy" | "not_ready" | "changed";

/** An error staff can act on. The message is safe to show. */
export class PricingError extends Error {
  constructor(
    public code: PricingErrorCode,
    message: string,
    /** Ivora's validation problems, one per line. */
    public problems: string[] = [],
  ) {
    super(message);
    this.name = "PricingError";
  }
}

export const notAllowed = () =>
  new PricingError(
    "not_allowed",
    "Only owners and managers can change prices. If your role just changed, reload the page.",
  );

export const notFound = () =>
  new PricingError(
    "not_found",
    "That tariff is not in the kit. Reload the page.",
  );

export const busy = () =>
  new PricingError(
    "busy",
    'The last change to this tariff is not confirmed by Ivora yet. Use "Finish saving" first.',
  );

export const notReady = () =>
  new PricingError(
    "not_ready",
    "That tariff is not in Ivora yet. Finish saving it before assigning it.",
  );

export const tariffChanged = () =>
  new PricingError(
    "changed",
    "Someone changed this tariff after you opened it. Reload the page to see the current prices, then make your change again.",
  );

export const stationChanged = () =>
  new PricingError(
    "changed",
    "Someone changed this charger's prices or access after you opened the page. Reload the page to see them, then make your change again.",
  );
