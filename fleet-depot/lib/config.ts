export const config = {
  apiBase: process.env.IVORA_API_BASE_URL ?? "https://api.ivora.example/v1",
  apiKey: process.env.IVORA_API_KEY ?? "",
  tenantId: process.env.IVORA_TENANT_ID ?? "",
  webhookSecret: process.env.IVORA_WEBHOOK_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  sqlitePath: process.env.SQLITE_PATH ?? "./data/depot.db",
  siteCapKw: Number(process.env.SITE_CAP_KW ?? 60),
  centsPerKwh: Number(process.env.TARIFF_CENTS_PER_KWH ?? 28),
  currency: process.env.TARIFF_CURRENCY ?? "EUR",
};

/** Demo mode runs offline with simulated data. It is on unless both credentials are set. */
export const isDemo = () =>
  process.env.DEMO_MODE === "true" || !(config.apiKey && config.tenantId);
