/**
 * The migrations this build ships, in file-name order, each with a probe: one read
 * that works only once the migration has been applied. Setup's database check asks
 * the probes rather than the `emsp_schema_migrations` ledger, so it is right for a
 * database migrated with `npm run db:migrate` and for one whose files were run by hand
 * in the SQL editor (which keeps no ledger).
 *
 * A build does not carry the SQL files at run time, so the list is written out here; a
 * test fails when it differs from `supabase/migrations`, and another applies the files
 * one by one and checks that each probe turns true with its own file. A new migration
 * therefore needs a line here, and something a read can see: a table, a column or a
 * function it creates.
 */
export type Probe =
  /** `select <column> from <table> limit 0`. */
  | { table: string; column: string }
  /** A call of a function, with arguments that read nothing. */
  | { rpc: string; args: Record<string, unknown> };

export type ShippedMigration = { file: string; probe: Probe };

export const MIGRATIONS: readonly ShippedMigration[] = [
  {
    file: "202610210001_baseline.sql",
    probe: { table: "emsp_audit_log", column: "id" },
  },
  {
    file: "202610210002_ocpi_peers.sql",
    probe: { table: "emsp_ocpi_peers", column: "id" },
  },
  {
    file: "202610210003_ocpi_locations_tariffs.sql",
    probe: { table: "emsp_ocpi_sync_state", column: "peer_id" },
  },
  {
    file: "202610210004_tokens.sql",
    probe: { table: "emsp_token_pushes", column: "peer_id" },
  },
  {
    file: "202610210005_commands.sql",
    probe: { table: "emsp_commands", column: "id" },
  },
  {
    file: "202610210006_sessions_cdrs.sql",
    probe: { table: "emsp_cdrs", column: "id" },
  },
  {
    file: "202610220001_live_data_adapters.sql",
    probe: { table: "emsp_live_data_adapters", column: "peer_id" },
  },
  {
    file: "202610220007_accounts_payments.sql",
    probe: { table: "emsp_stripe_events", column: "id" },
  },
  {
    file: "202610220008_admin_web.sql",
    probe: {
      rpc: "emsp_payment_reconciliation",
      // An empty range: the call reads no row.
      args: {
        p_from: "2000-01-01T00:00:00Z",
        p_to: "2000-01-01T00:00:00Z",
        p_peer_id: null,
      },
    },
  },
  {
    file: "202610220009_driver_app.sql",
    probe: { table: "emsp_problem_reports", column: "id" },
  },
  {
    file: "202611130001_payment_safety.sql",
    probe: { table: "emsp_payment_sweeps", column: "id" },
  },
  {
    file: "202611160001_hub_parties.sql",
    probe: { table: "emsp_ocpi_peers", column: "hub_parties" },
  },
  {
    file: "202611160002_peer_rev.sql",
    probe: { table: "emsp_ocpi_peers", column: "rev" },
  },
  {
    file: "202611240001_hub_push_mode.sql",
    probe: { table: "emsp_ocpi_peers", column: "hub_push_mode" },
  },
];
