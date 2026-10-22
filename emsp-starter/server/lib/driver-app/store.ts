import "server-only";
import { randomUUID } from "node:crypto";

/**
 * The driver app's own data: push tokens, favourite locations and problem reports.
 * Drivers reach it through the driver API only; the admin web reads the reports.
 */
export type PushPlatform = "ios" | "android";

export type PushToken = {
  token: string;
  driverRef: string;
  platform: PushPlatform;
  /** BCP 47 language tag of the device, for the notification's words. */
  locale: string;
  createdAt: string;
  updatedAt: string;
};

export type Favourite = { locationId: string; createdAt: string };

export const PROBLEM_CATEGORIES = [
  "not_starting",
  "stopped_early",
  "damaged",
  "blocked",
  "payment",
  "other",
] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

export type PhotoType = "image/jpeg" | "image/png";

export type ProblemReport = {
  id: string;
  driverRef: string;
  locationId: string;
  evseUid: string | null;
  category: ProblemCategory;
  message: string;
  photoType: PhotoType | null;
  photoBase64: string | null;
  status: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type NewProblemReport = Pick<
  ProblemReport,
  | "driverRef"
  | "locationId"
  | "evseUid"
  | "category"
  | "message"
  | "photoType"
  | "photoBase64"
>;

/** Most push tokens kept per driver: the oldest goes first. */
export const MAX_PUSH_TOKENS = 10;
/** Most favourites per driver. */
export const MAX_FAVOURITES = 100;

export interface DriverAppStore {
  /** Saves a device's token for this driver; a token another driver had moves here. */
  putPushToken(
    t: Omit<PushToken, "createdAt" | "updatedAt">,
    now: string,
  ): Promise<PushToken>;
  /** False when this driver had no such token. */
  removePushToken(driverRef: string, token: string): Promise<boolean>;
  /** Newest first. */
  listPushTokens(driverRef: string): Promise<PushToken[]>;
  /** A token the push provider says is gone (the app was removed). */
  forgetPushToken(token: string): Promise<void>;

  /** Newest first. */
  listFavourites(driverRef: string): Promise<Favourite[]>;
  /** True when it was added now, false when it was already there. */
  addFavourite(
    driverRef: string,
    locationId: string,
    now: string,
  ): Promise<boolean>;
  removeFavourite(driverRef: string, locationId: string): Promise<boolean>;

  addReport(r: NewProblemReport, now: string): Promise<ProblemReport>;
  getReport(id: string): Promise<ProblemReport | null>;
  /** Newest first. Without the photo, which `getReport` gives. */
  listReports(q: {
    status?: "open" | "resolved";
    limit: number;
  }): Promise<ProblemReport[]>;
  /** How many reports this driver sent since `since`, for the rate limit. */
  countReportsSince(driverRef: string, since: string): Promise<number>;
  /** Null when there is no such open report. */
  resolveReport(
    id: string,
    actor: string,
    now: string,
  ): Promise<ProblemReport | null>;
}

const newestFirst = <T extends { createdAt: string }>(a: T, b: T) =>
  b.createdAt.localeCompare(a.createdAt);

/** In memory: for demo mode (nothing persists) and for tests. */
export class MemoryDriverAppStore implements DriverAppStore {
  readonly pushTokens = new Map<string, PushToken>();
  readonly favourites = new Map<string, Map<string, Favourite>>();
  readonly reports = new Map<string, ProblemReport>();

  async putPushToken(
    t: Omit<PushToken, "createdAt" | "updatedAt">,
    now: string,
  ) {
    const held = this.pushTokens.get(t.token);
    const row: PushToken = {
      ...t,
      createdAt: held && held.driverRef === t.driverRef ? held.createdAt : now,
      updatedAt: now,
    };
    this.pushTokens.set(t.token, row);
    const mine = await this.listPushTokens(t.driverRef);
    for (const old of mine.slice(MAX_PUSH_TOKENS))
      this.pushTokens.delete(old.token);
    return { ...row };
  }

  async removePushToken(driverRef: string, token: string) {
    const held = this.pushTokens.get(token);
    if (!held || held.driverRef !== driverRef) return false;
    return this.pushTokens.delete(token);
  }

  async listPushTokens(driverRef: string) {
    return [...this.pushTokens.values()]
      .filter((t) => t.driverRef === driverRef)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => ({ ...t }));
  }

  async forgetPushToken(token: string) {
    this.pushTokens.delete(token);
  }

  async listFavourites(driverRef: string) {
    return [...(this.favourites.get(driverRef)?.values() ?? [])]
      .sort(newestFirst)
      .map((f) => ({ ...f }));
  }

  async addFavourite(driverRef: string, locationId: string, now: string) {
    const mine = this.favourites.get(driverRef) ?? new Map();
    this.favourites.set(driverRef, mine);
    if (mine.has(locationId)) return false;
    mine.set(locationId, { locationId, createdAt: now });
    return true;
  }

  async removeFavourite(driverRef: string, locationId: string) {
    return this.favourites.get(driverRef)?.delete(locationId) ?? false;
  }

  async addReport(r: NewProblemReport, now: string) {
    const report: ProblemReport = {
      ...r,
      id: randomUUID(),
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
    };
    this.reports.set(report.id, report);
    return { ...report };
  }

  async getReport(id: string) {
    const r = this.reports.get(id);
    return r ? { ...r } : null;
  }

  async listReports(q: { status?: "open" | "resolved"; limit: number }) {
    return [...this.reports.values()]
      .filter((r) => !q.status || r.status === q.status)
      .sort(newestFirst)
      .slice(0, q.limit)
      .map((r) => ({ ...r, photoBase64: null }));
  }

  async countReportsSince(driverRef: string, since: string) {
    return [...this.reports.values()].filter(
      (r) => r.driverRef === driverRef && r.createdAt >= since,
    ).length;
  }

  async resolveReport(id: string, actor: string, now: string) {
    const r = this.reports.get(id);
    if (!r || r.status !== "open") return null;
    const done = {
      ...r,
      status: "resolved" as const,
      resolvedBy: actor,
      resolvedAt: now,
    };
    this.reports.set(id, done);
    return { ...done };
  }
}
