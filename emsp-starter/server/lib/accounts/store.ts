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
};

export type DriverPatch = Partial<
  Pick<Driver, "email" | "status" | "defaultPaymentMethodId">
>;

export type AdminRole = "admin" | "viewer";

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
  adminRole(userId: string): Promise<AdminRole | null>;
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

  async adminRole(userId: string) {
    return this.admins.get(userId) ?? null;
  }
}
