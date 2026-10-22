import "server-only";
import {
  eq,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import {
  MAX_PUSH_TOKENS,
  type DriverAppStore,
  type Favourite,
  type NewProblemReport,
  type ProblemReport,
  type PushToken,
} from "./store";

type PushRow = {
  token: string;
  driver_ref: string;
  platform: PushToken["platform"];
  locale: string;
  created_at: string;
  updated_at: string;
};

type FavouriteRow = { location_id: string; created_at: string };

type ReportRow = {
  id: string;
  driver_ref: string;
  location_id: string;
  evse_uid: string | null;
  category: ProblemReport["category"];
  message: string;
  photo_type: ProblemReport["photoType"];
  photo_base64?: string | null;
  status: ProblemReport["status"];
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

const toPush = (r: PushRow): PushToken => ({
  token: r.token,
  driverRef: r.driver_ref,
  platform: r.platform,
  locale: r.locale,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toFavourite = (r: FavouriteRow): Favourite => ({
  locationId: r.location_id,
  createdAt: r.created_at,
});

const toReport = (r: ReportRow): ProblemReport => ({
  id: r.id,
  driverRef: r.driver_ref,
  locationId: r.location_id,
  evseUid: r.evse_uid,
  category: r.category,
  message: r.message,
  photoType: r.photo_type,
  photoBase64: r.photo_base64 ?? null,
  status: r.status,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
});

const PUSH = "emsp_push_tokens";
const FAVOURITES = "emsp_favourites";
const REPORTS = "emsp_problem_reports";
/** A report's columns without the photo, for lists. */
const REPORT_LIST_COLUMNS =
  "id,driver_ref,location_id,evse_uid,category,message,photo_type,status,resolved_by,resolved_at,created_at";

/** The driver app's data in Supabase Postgres, as the service role. */
export class SupabaseDriverAppStore implements DriverAppStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
  }

  async putPushToken(
    t: Omit<PushToken, "createdAt" | "updatedAt">,
    now: string,
  ) {
    const values = {
      driver_ref: t.driverRef,
      platform: t.platform,
      locale: t.locale,
      updated_at: now,
    };
    let saved: PushRow | undefined;
    // Update, else insert; an insert that lost a race to another one updates after all.
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      [saved] = await this.rest<PushRow[]>(
        "PATCH",
        `${PUSH}?token=${eq(t.token)}`,
        values,
        "return=representation",
      );
      if (saved) break;
      [saved] = await this.rest<PushRow[]>(
        "POST",
        `${PUSH}?on_conflict=token`,
        { token: t.token, ...values, created_at: now },
        "return=representation,resolution=ignore-duplicates",
      );
    }
    if (!saved) throw new Error("Push token could not be saved");
    for (const old of (await this.listPushTokens(t.driverRef)).slice(
      MAX_PUSH_TOKENS,
    ))
      await this.rest("DELETE", `${PUSH}?token=${eq(old.token)}`);
    return toPush(saved);
  }

  async removePushToken(driverRef: string, token: string) {
    const rows = await this.rest<PushRow[]>(
      "DELETE",
      `${PUSH}?token=${eq(token)}&driver_ref=${eq(driverRef)}`,
      undefined,
      "return=representation",
    );
    return rows.length > 0;
  }

  async listPushTokens(driverRef: string) {
    const rows = await this.rest<PushRow[]>(
      "GET",
      `${PUSH}?driver_ref=${eq(driverRef)}&select=*&order=updated_at.desc&limit=50`,
    );
    return rows.map(toPush);
  }

  async forgetPushToken(token: string) {
    await this.rest("DELETE", `${PUSH}?token=${eq(token)}`);
  }

  async listFavourites(driverRef: string) {
    const rows = await this.rest<FavouriteRow[]>(
      "GET",
      `${FAVOURITES}?driver_ref=${eq(driverRef)}&select=location_id,created_at&order=created_at.desc&limit=500`,
    );
    return rows.map(toFavourite);
  }

  async addFavourite(driverRef: string, locationId: string, now: string) {
    const rows = await this.rest<FavouriteRow[]>(
      "POST",
      `${FAVOURITES}?on_conflict=driver_ref,location_id`,
      { driver_ref: driverRef, location_id: locationId, created_at: now },
      "return=representation,resolution=ignore-duplicates",
    );
    return rows.length > 0;
  }

  async removeFavourite(driverRef: string, locationId: string) {
    const rows = await this.rest<FavouriteRow[]>(
      "DELETE",
      `${FAVOURITES}?driver_ref=${eq(driverRef)}&location_id=${eq(locationId)}`,
      undefined,
      "return=representation",
    );
    return rows.length > 0;
  }

  async addReport(r: NewProblemReport, now: string) {
    const [row] = await this.rest<ReportRow[]>(
      "POST",
      `${REPORTS}?on_conflict=id&select=${REPORT_LIST_COLUMNS}`,
      {
        driver_ref: r.driverRef,
        location_id: r.locationId,
        evse_uid: r.evseUid,
        category: r.category,
        message: r.message,
        photo_type: r.photoType,
        photo_base64: r.photoBase64,
        created_at: now,
      },
      "return=representation,resolution=ignore-duplicates",
    );
    if (!row) throw new Error("Problem report could not be saved");
    return { ...toReport(row), photoBase64: r.photoBase64 };
  }

  async getReport(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.rest<ReportRow[]>(
      "GET",
      `${REPORTS}?id=${eq(id)}&select=*`,
    );
    return rows[0] ? toReport(rows[0]) : null;
  }

  async listReports(q: { status?: "open" | "resolved"; limit: number }) {
    const filter = q.status ? `status=${eq(q.status)}&` : "";
    const rows = await this.rest<ReportRow[]>(
      "GET",
      `${REPORTS}?${filter}select=${REPORT_LIST_COLUMNS}&order=created_at.desc&limit=${q.limit}`,
    );
    return rows.map(toReport);
  }

  async countReportsSince(driverRef: string, since: string) {
    const rows = await this.rest<{ id: string }[]>(
      "GET",
      `${REPORTS}?driver_ref=${eq(driverRef)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=100`,
    );
    return rows.length;
  }

  async resolveReport(id: string, actor: string, now: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.rest<ReportRow[]>(
      "PATCH",
      `${REPORTS}?id=${eq(id)}&status=eq.open&select=${REPORT_LIST_COLUMNS}`,
      { status: "resolved", resolved_by: actor, resolved_at: now },
      "return=representation",
    );
    return row ? toReport(row) : null;
  }
}
