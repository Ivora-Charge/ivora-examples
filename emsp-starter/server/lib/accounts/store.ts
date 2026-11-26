import "server-only";

/**
 * Driver accounts and admin roles.
 *
 * A driver signs in without a password (Supabase Auth, an email code or link); the
 * first sign-in makes the account, keyed by the Supabase Auth user ID, which is also
 * the `driverRef` of the driver's tokens, commands and payments. The account keeps the
 * driver's Stripe Customer ID and the ID of the card they chose as default: Stripe
 * holds the cards, never us.
 *
 * Admins are Supabase Auth users listed in the admin role table (`emsp_admins`), which
 * the server only reads.
 */
export type DriverStatus = "active" | "restricted";

export type Driver = {
  id: string;
  email: string;
  status: DriverStatus;
  stripeCustomerId: string | null;
  defaultPaymentMethodId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null: none recorded (none since the column was added, or not migrated yet). */
  lastSignInAt: string | null;
};

export type DriverPatch = Partial<
  Pick<Driver, "email" | "status" | "defaultPaymentMethodId">
>;

export type AdminRole = "admin" | "viewer";

/**
 * Which accounts a list or a count is about: every field set narrows it, none means all
 * of them. Another kind of filter (guests, say) is another field here.
 */
export type DriverFilter = {
  /**
   * Part of the email address, any letter case. Use `emailSearchTerm` on what was
   * typed: a store throws for a term that it would not return unchanged.
   */
  email?: string;
  /** The exact driver reference (the account ID). */
  reference?: string;
};

/** Where the next page of a list starts: after this account. */
export type DriverCursor = { createdAt: string; id: string };

export type DriverListQuery = DriverFilter & {
  after?: DriverCursor;
  limit: number;
};

export type DriverPage = {
  drivers: Driver[];
  /** Null on the last page. */
  next: DriverCursor | null;
};

export type DriverCountQuery = DriverFilter & {
  /** "Signed in lately" means at or after this time. */
  signedInSince: string;
};

export type DriverCounts = {
  /** Every account, whatever the filter; so are the next three. */
  total: number;
  /** Status "restricted". */
  blocked: number;
  withCard: number;
  /** Null: the database has no sign-in times yet (a migration is pending). */
  signedInSince: number | null;
  /** The accounts the filter matches: the "n" of "n of m". */
  matching: number;
};

/**
 * An email search as the stores take it: trimmed and lower case. Null for anything
 * that is not part of an address: empty, over 254 characters, or with a space, a
 * control character or one of `* \ " ( ) , ; : < > [ ]` (`*` would be a wildcard to
 * the database).
 */
export function emailSearchTerm(input: string): string | null {
  const term = input.trim().toLowerCase();
  return /^[^\s\u0000-\u001f\u007f*\\"(),;:<>[\]]{1,254}$/.test(term)
    ? term
    : null;
}

/** The term, or an error: a store never searches for something unchecked. */
export function checkedEmailTerm(term: string): string {
  if (emailSearchTerm(term) !== term)
    throw new Error("Unchecked email search term");
  return term;
}

export interface AccountStore {
  getDriver(id: string): Promise<Driver | null>;
  getDriverByCustomer(customerId: string): Promise<Driver | null>;
  /** The account of this user, made now if it is new. */
  ensureDriver(id: string, email: string, now: string): Promise<Driver>;
  /** Sets the Stripe Customer only while none is set; null when one is (read again). */
  setCustomer(
    id: string,
    customerId: string,
    now: string,
  ): Promise<Driver | null>;
  updateDriver(
    id: string,
    patch: DriverPatch,
    now: string,
  ): Promise<Driver | null>;
  /** Notes that the driver signed in now. Nothing happens without an account. */
  recordSignIn(id: string, now: string): Promise<void>;
  /** Accounts, newest first (by when they joined, then by ID), one page at a time. */
  listDrivers(query: DriverListQuery): Promise<DriverPage>;
  countDrivers(query: DriverCountQuery): Promise<DriverCounts>;
  adminRole(userId: string): Promise<AdminRole | null>;
  /** How many users are on the admin list, whatever their role (at most 1,000). */
  countAdmins(): Promise<number>;
  /** Whether anyone is on the admin list, by reading at most one row of it. */
  hasAdmin(): Promise<boolean>;
}

/** Accounts in memory: for demo mode (nothing persists) and for tests. */
export class MemoryAccountStore implements AccountStore {
  readonly drivers = new Map<string, Driver>();
  readonly admins = new Map<string, AdminRole>();

  async getDriver(id: string) {
    const d = this.drivers.get(id);
    return d ? structuredClone(d) : null;
  }

  async getDriverByCustomer(customerId: string) {
    for (const d of this.drivers.values())
      if (d.stripeCustomerId === customerId) return structuredClone(d);
    return null;
  }

  async ensureDriver(id: string, email: string, now: string) {
    let d = this.drivers.get(id);
    if (!d) {
      d = {
        id,
        email,
        status: "active",
        stripeCustomerId: null,
        defaultPaymentMethodId: null,
        createdAt: now,
        updatedAt: now,
        lastSignInAt: null,
      };
      this.drivers.set(id, d);
    } else if (d.email !== email) Object.assign(d, { email, updatedAt: now });
    return structuredClone(d);
  }

  async setCustomer(id: string, customerId: string, now: string) {
    const d = this.drivers.get(id);
    if (!d || d.stripeCustomerId) return null;
    Object.assign(d, { stripeCustomerId: customerId, updatedAt: now });
    return structuredClone(d);
  }

  async updateDriver(id: string, patch: DriverPatch, now: string) {
    const d = this.drivers.get(id);
    if (!d) return null;
    Object.assign(d, structuredClone(patch), { updatedAt: now });
    return structuredClone(d);
  }

  async recordSignIn(id: string, now: string) {
    const d = this.drivers.get(id);
    if (d) d.lastSignInAt = now;
  }

  private matches(d: Driver, { email, reference }: DriverFilter) {
    return (
      (email === undefined || d.email.toLowerCase().includes(email)) &&
      (reference === undefined || d.id === reference)
    );
  }

  async listDrivers({ after, limit, ...filter }: DriverListQuery) {
    if (filter.email !== undefined) checkedEmailTerm(filter.email);
    const newestFirst = (a: DriverCursor, b: DriverCursor) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const rest = [...this.drivers.values()]
      .filter(
        (d) => this.matches(d, filter) && (!after || newestFirst(after, d) < 0),
      )
      .sort(newestFirst);
    const drivers = rest.slice(0, limit).map((d) => structuredClone(d));
    const last = drivers.at(-1);
    return {
      drivers,
      next:
        rest.length > drivers.length && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  async countDrivers({ signedInSince, ...filter }: DriverCountQuery) {
    if (filter.email !== undefined) checkedEmailTerm(filter.email);
    const all = [...this.drivers.values()];
    const since = Date.parse(signedInSince);
    return {
      total: all.length,
      blocked: all.filter((d) => d.status === "restricted").length,
      withCard: all.filter((d) => d.defaultPaymentMethodId !== null).length,
      signedInSince: all.filter(
        (d) => d.lastSignInAt !== null && Date.parse(d.lastSignInAt) >= since,
      ).length,
      matching: all.filter((d) => this.matches(d, filter)).length,
    };
  }

  async adminRole(userId: string) {
    return this.admins.get(userId) ?? null;
  }

  async countAdmins() {
    return this.admins.size;
  }

  async hasAdmin() {
    return this.admins.size > 0;
  }
}
