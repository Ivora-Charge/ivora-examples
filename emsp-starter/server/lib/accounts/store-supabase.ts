import "server-only";
import {
  ABSENT_CODES,
  DatabaseRequestError,
  eq,
  errorCode,
  supabaseRequest,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import {
  checkedEmailTerm,
  type AccountStore,
  type AdminRole,
  type Driver,
  type DriverCountQuery,
  type DriverCursor,
  type DriverFilter,
  type DriverListQuery,
  type DriverPatch,
  type DriverStatus,
} from "./store";

type DriverRow = {
  id: string;
  email: string;
  status: DriverStatus;
  stripe_customer_id: string | null;
  default_payment_method_id: string | null;
  created_at: string;
  updated_at: string;
  /** Absent before the 202611260001 migration. */
  last_sign_in_at?: string | null;
};

const iso = (v: string) => new Date(v).toISOString();

const driver = (r: DriverRow): Driver => ({
  id: r.id,
  email: r.email,
  status: r.status,
  stripeCustomerId: r.stripe_customer_id,
  defaultPaymentMethodId: r.default_payment_method_id,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  lastSignInAt: r.last_sign_in_at ? iso(r.last_sign_in_at) : null,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * The filter as query parameters; null when nothing can match it. An account ID is a
 * lower-case UUID, so any other reference has no account: asking the database for one
 * would be an error, not an empty answer.
 */
function filterParams({ email, reference }: DriverFilter): string[] | null {
  const out: string[] = [];
  if (reference !== undefined) {
    if (!UUID.test(reference)) return null;
    out.push(`id=${eq(reference)}`);
  }
  if (email !== undefined) {
    // `%`, `_` and `\` mean themselves here, so they are escaped for ILIKE.
    const literal = checkedEmailTerm(email).replace(/[\\%_]/g, "\\$&");
    out.push(`email=ilike.${encodeURIComponent(`*${literal}*`)}`);
  }
  return out;
}

/**
 * The accounts after the cursor, newest first. The timestamp is the database's own
 * text, to the microsecond. Both values are checked, so neither can change the filter.
 */
function afterParam({ createdAt, id }: DriverCursor): string {
  if (!TIMESTAMP.test(createdAt) || !UUID.test(id))
    throw new Error("Unchecked driver cursor");
  const at = `"${createdAt}"`;
  return `or=${encodeURIComponent(
    `(created_at.lt.${at},and(created_at.eq.${at},id.lt.${id}))`,
  )}`;
}

const COLUMNS: Record<keyof DriverPatch, keyof DriverRow> = {
  email: "email",
  status: "status",
  defaultPaymentMethodId: "default_payment_method_id",
};

/** Accounts in Supabase Postgres (emsp_drivers, emsp_admins), as the service role. */
export class SupabaseAccountStore implements AccountStore {
  private readonly rest: ReturnType<typeof supabaseRest>;
  private readonly request: ReturnType<typeof supabaseRequest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
    this.request = supabaseRequest(url, serviceRoleKey, transport);
  }

  private async one(filter: string): Promise<Driver | null> {
    const [row] = await this.rest<DriverRow[]>(
      "GET",
      `emsp_drivers?${filter}&select=*`,
    );
    return row ? driver(row) : null;
  }

  getDriver(id: string) {
    return this.one(`id=${eq(id)}`);
  }

  getDriverByCustomer(customerId: string) {
    return this.one(`stripe_customer_id=${eq(customerId)}`);
  }

  async ensureDriver(id: string, email: string, now: string) {
    await this.rest(
      "POST",
      "emsp_drivers?on_conflict=id",
      { id, email, created_at: now, updated_at: now },
      "resolution=ignore-duplicates,return=minimal",
    );
    const held = await this.getDriver(id);
    if (!held) throw new Error("Database request failed: emsp_drivers");
    if (held.email === email) return held;
    return (await this.updateDriver(id, { email }, now)) ?? held;
  }

  async setCustomer(id: string, customerId: string, now: string) {
    const [row] = await this.rest<DriverRow[]>(
      "PATCH",
      `emsp_drivers?id=${eq(id)}&stripe_customer_id=is.null&select=*`,
      { stripe_customer_id: customerId, updated_at: now },
      "return=representation",
    );
    return row ? driver(row) : null;
  }

  async updateDriver(id: string, patch: DriverPatch, now: string) {
    const body: Record<string, unknown> = { updated_at: now };
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) body[COLUMNS[k as keyof DriverPatch]] = v;
    const [row] = await this.rest<DriverRow[]>(
      "PATCH",
      `emsp_drivers?id=${eq(id)}&select=*`,
      body,
      "return=representation",
    );
    return row ? driver(row) : null;
  }

  async recordSignIn(id: string, now: string) {
    await this.rest(
      "PATCH",
      `emsp_drivers?id=${eq(id)}`,
      { last_sign_in_at: now },
      "return=minimal",
    );
  }

  async listDrivers({ after, limit, ...filter }: DriverListQuery) {
    const params = filterParams(filter);
    if (!params) return { drivers: [], next: null };
    const size = Math.max(1, Math.floor(limit));
    // One more than the page, to know whether there is another.
    const rows = await this.rest<DriverRow[]>(
      "GET",
      `emsp_drivers?${[
        ...params,
        ...(after ? [afterParam(after)] : []),
        "select=*",
        "order=created_at.desc,id.desc",
        `limit=${size + 1}`,
      ].join("&")}`,
    );
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      drivers: page.map(driver),
      next:
        rows.length > size && last
          ? { createdAt: last.created_at, id: last.id }
          : null,
    };
  }

  /** How many accounts match, counted by the database; no row is read. */
  private async count(params: string[]): Promise<number> {
    const res = await this.request(
      "HEAD",
      `emsp_drivers?${[...params, "select=id"].join("&")}`,
      undefined,
      "count=exact",
    );
    const n = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (!res.ok || n === undefined)
      throw new DatabaseRequestError(
        `Database request failed: HEAD emsp_drivers (HTTP ${res.status})`,
        res.status,
        res.ok ? null : await errorCode(res),
      );
    return Number(n);
  }

  /** Null when the database has no sign-in times yet; any other failure is thrown. */
  private async countSignedIn(since: string): Promise<number | null> {
    try {
      return await this.count([
        `last_sign_in_at=gte.${encodeURIComponent(since)}`,
      ]);
    } catch (e) {
      // A refused HEAD has no body to say why: ask for the column itself.
      try {
        await this.rest("GET", "emsp_drivers?select=last_sign_in_at&limit=0");
      } catch (why) {
        if (
          why instanceof DatabaseRequestError &&
          why.code !== null &&
          ABSENT_CODES.has(why.code)
        )
          return null;
      }
      throw e;
    }
  }

  async countDrivers({ signedInSince, ...filter }: DriverCountQuery) {
    const params = filterParams(filter);
    const [total, blocked, withCard, recent, matching] = await Promise.all([
      this.count([]),
      this.count(["status=eq.restricted"]),
      this.count(["default_payment_method_id=not.is.null"]),
      this.countSignedIn(signedInSince),
      // Without a filter, every account matches.
      params === null ? 0 : params.length ? this.count(params) : null,
    ]);
    return {
      total,
      blocked,
      withCard,
      signedInSince: recent,
      matching: matching ?? total,
    };
  }

  async adminRole(userId: string): Promise<AdminRole | null> {
    const [row] = await this.rest<{ role: AdminRole }[]>(
      "GET",
      `emsp_admins?user_id=${eq(userId)}&select=role`,
    );
    return row?.role ?? null;
  }

  async countAdmins(): Promise<number> {
    const rows = await this.rest<unknown[]>(
      "GET",
      "emsp_admins?select=role&limit=1000",
    );
    return rows.length;
  }

  async hasAdmin(): Promise<boolean> {
    const rows = await this.rest<unknown[]>(
      "GET",
      "emsp_admins?select=role&limit=1",
    );
    return rows.length > 0;
  }
}
