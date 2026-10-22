import "server-only";
import {
  eq,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import type {
  AccountStore,
  AdminRole,
  Driver,
  DriverPatch,
  DriverStatus,
} from "./store";

type DriverRow = {
  id: string;
  email: string;
  status: DriverStatus;
  stripe_customer_id: string | null;
  default_payment_method_id: string | null;
  created_at: string;
  updated_at: string;
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
});

const COLUMNS: Record<keyof DriverPatch, keyof DriverRow> = {
  email: "email",
  status: "status",
  defaultPaymentMethodId: "default_payment_method_id",
};

/** Accounts in Supabase Postgres (emsp_drivers, emsp_admins), as the service role. */
export class SupabaseAccountStore implements AccountStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
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

  async adminRole(userId: string): Promise<AdminRole | null> {
    const [row] = await this.rest<{ role: AdminRole }[]>(
      "GET",
      `emsp_admins?user_id=${eq(userId)}&select=role`,
    );
    return row?.role ?? null;
  }
}
