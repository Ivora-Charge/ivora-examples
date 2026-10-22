// Types for the tables and functions in supabase/migrations, in the shape that
// `supabase gen types typescript` produces. Update them with each migration.

type Timestamp = string;
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      cpo_operators: {
        Row: { id: string; name: string; created_at: Timestamp };
        Insert: { id?: string; name: string; created_at?: Timestamp };
        Update: { id?: string; name?: string; created_at?: Timestamp };
        Relationships: [];
      };
      cpo_staff: {
        Row: {
          operator_id: string;
          user_id: string;
          email: string;
          role: string;
          created_at: Timestamp;
        };
        Insert: {
          operator_id: string;
          user_id: string;
          email: string;
          role: string;
          created_at?: Timestamp;
        };
        Update: {
          operator_id?: string;
          user_id?: string;
          email?: string;
          role?: string;
          created_at?: Timestamp;
        };
        Relationships: [];
      };
      cpo_invites: {
        Row: {
          id: string;
          operator_id: string;
          email: string;
          role: string;
          token_hash: string;
          invited_by: string | null;
          expires_at: Timestamp;
          accepted_at: Timestamp | null;
          revoked_at: Timestamp | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          operator_id: string;
          email: string;
          role: string;
          token_hash: string;
          invited_by?: string | null;
          expires_at: Timestamp;
          accepted_at?: Timestamp | null;
          revoked_at?: Timestamp | null;
          created_at?: Timestamp;
        };
        Update: {
          accepted_at?: Timestamp | null;
          revoked_at?: Timestamp | null;
        };
        Relationships: [];
      };
      cpo_rate_limits: {
        Row: { key: string; attempts: number; resets_at: Timestamp };
        Insert: { key: string; attempts: number; resets_at: Timestamp };
        Update: { attempts?: number; resets_at?: Timestamp };
        Relationships: [];
      };
      cpo_company_profiles: {
        Row: {
          operator_id: string;
          name: string | null;
          support_email: string | null;
          support_url: string | null;
          website: string | null;
          time_zone: string | null;
          currency: string | null;
          primary_color: string | null;
          logo_url: string | null;
          branding_hash: string | null;
          branding_synced_at: Timestamp | null;
          branding_syncs: number;
          logo_uploads: number;
          updated_by: string | null;
          updated_at: Timestamp;
        };
        // Written only through the cpo_save_* and cpo_record_branding functions.
        Insert: { operator_id: string };
        Update: { [_ in never]: never };
        Relationships: [];
      };
      cpo_chargers: {
        Row: {
          id: string;
          operator_id: string;
          station_id: number | null;
          name: string;
          label: string | null;
          location_id: number | null;
          new_site: Json | null;
          connectors: number;
          connection_url: string | null;
          password_set_at: Timestamp | null;
          credential_sets: number;
          test_runs: number;
          edits: number;
          connection_test: Json | null;
          remote_test: Json | null;
          created_by: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          removed_at: Timestamp | null;
        };
        // Written only through the cpo_*_charger functions.
        Insert: { operator_id: string; name: string };
        Update: { [_ in never]: never };
        Relationships: [];
      };
      cpo_sticker_codes: {
        Row: {
          code: string;
          operator_id: string;
          charger_id: string;
          connector_number: number;
          connector_id: number | null;
          created_at: Timestamp;
        };
        // Written only through cpo_add_sticker_codes.
        Insert: {
          code: string;
          operator_id: string;
          charger_id: string;
          connector_number: number;
        };
        Update: { [_ in never]: never };
        Relationships: [];
      };
      cpo_live_commands: {
        Row: {
          id: string;
          operator_id: string;
          request_id: string;
          station_id: number;
          action: string;
          connector_id: number | null;
          transaction_id: number | null;
          mode: string | null;
          phase: string;
          operation_id: string | null;
          charger_status: string | null;
          error: string | null;
          confirmed_sessions: number[];
          requested_by: string | null;
          requested_at: Timestamp;
          updated_at: Timestamp;
          finished_at: Timestamp | null;
        };
        // Written only through cpo_claim_live_command and cpo_record_live_command.
        Insert: { operator_id: string; request_id: string };
        Update: { [_ in never]: never };
        Relationships: [];
      };
      cpo_ivora_events: {
        Row: {
          id: string;
          type: string;
          station_id: number | null;
          received_at: Timestamp;
          processed_at: Timestamp | null;
        };
        // Inserted only through cpo_record_ivora_event.
        Insert: { id: string; type: string };
        Update: { processed_at?: Timestamp | null };
        Relationships: [];
      };
      cpo_checkouts: {
        Row: {
          id: string;
          operator_id: string;
          request_id: string;
          reference: string;
          kind: string;
          sticker_code: string;
          station_id: number;
          connector_id: number;
          tariff_id: number;
          hold_minor: number;
          currency: string;
          phase: string;
          bill_id: string | null;
          payment_id: string | null;
          checkout_url: string | null;
          start_requested_at: Timestamp | null;
          start_operation_id: string | null;
          transaction_id: number | null;
          stop_requested_at: Timestamp | null;
          stop_retried_at: Timestamp | null;
          meter_wh: number | null;
          meter_at: Timestamp | null;
          alert: string | null;
          final_minor: number | null;
          captured_minor: number | null;
          error: string | null;
          checked_at: Timestamp | null;
          settled_at: Timestamp | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          session_started_at: Timestamp | null;
          session_ended_at: Timestamp | null;
          energy_wh: number | null;
          connector_number: number | null;
          stop_reason: string | null;
          detail_at: Timestamp | null;
          detail_checked_at: Timestamp | null;
          refunded_minor: number | null;
          refund_checked_at: Timestamp | null;
        };
        // Written only through cpo_claim_checkout, cpo_record_checkout and the
        // reports' cpo_record_checkout_details and cpo_record_checkout_payment.
        Insert: { operator_id: string; request_id: string };
        Update: { [_ in never]: never };
        Relationships: [];
      };
      cpo_staff_tokens: {
        Row: {
          operator_id: string;
          id_token: string;
          token_id: number | null;
          created_at: Timestamp;
          registered_at: Timestamp | null;
        };
        Insert: {
          operator_id: string;
          id_token: string;
          token_id?: number | null;
          registered_at?: Timestamp | null;
        };
        Update: {
          id_token?: string;
          token_id?: number | null;
          registered_at?: Timestamp | null;
        };
        Relationships: [];
      };
      cpo_free_tokens: {
        Row: {
          operator_id: string;
          id_token: string;
          token_id: number | null;
          created_at: Timestamp;
          registered_at: Timestamp | null;
        };
        Insert: {
          operator_id: string;
          id_token: string;
          token_id?: number | null;
          registered_at?: Timestamp | null;
        };
        Update: {
          id_token?: string;
          token_id?: number | null;
          registered_at?: Timestamp | null;
        };
        Relationships: [];
      };
      cpo_transaction_marks: {
        Row: {
          station_id: number;
          last_transaction_id: number;
          updated_at: Timestamp;
        };
        // Written only through cpo_advance_transaction_mark.
        Insert: { station_id: number; last_transaction_id: number };
        Update: { [_ in never]: never };
        Relationships: [];
      };
      cpo_tariffs: {
        Row: {
          id: string;
          operator_id: string;
          name: string;
          revision: number;
          last_version: number;
          created_by: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          operator_id: string;
          name: string;
          created_by?: string | null;
        };
        Update: {
          name?: string;
          revision?: number;
          last_version?: number;
          updated_at?: Timestamp;
        };
        Relationships: [];
      };
      cpo_tariff_versions: {
        Row: {
          tariff_id: string;
          operator_id: string;
          version: number;
          definition: Json;
          ivora_tariff_id: number | null;
          attempt: number;
          attempted_at: Timestamp;
          archived_at: Timestamp | null;
          created_by: string | null;
          created_at: Timestamp;
        };
        Insert: {
          tariff_id: string;
          operator_id: string;
          version: number;
          definition: Json;
          ivora_tariff_id?: number | null;
          created_by?: string | null;
        };
        Update: {
          ivora_tariff_id?: number | null;
          attempt?: number;
          attempted_at?: Timestamp;
          archived_at?: Timestamp | null;
        };
        Relationships: [];
      };
      cpo_station_pricing: {
        Row: {
          operator_id: string;
          station_id: number;
          tariff_id: string | null;
          private: boolean;
          revision: number;
          updated_by: string | null;
          updated_at: Timestamp;
        };
        Insert: {
          operator_id: string;
          station_id: number;
          tariff_id?: string | null;
          private?: boolean;
          updated_by?: string | null;
        };
        Update: {
          tariff_id?: string | null;
          private?: boolean;
          revision?: number;
        };
        Relationships: [];
      };
      cpo_connector_tariffs: {
        Row: {
          operator_id: string;
          station_id: number;
          connector_id: number;
          tariff_id: string;
          updated_by: string | null;
          updated_at: Timestamp;
        };
        Insert: {
          operator_id: string;
          station_id: number;
          connector_id: number;
          tariff_id: string;
          updated_by?: string | null;
        };
        Update: { tariff_id?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      cpo_bootstrap_owner: {
        Args: { p_user_id: string; p_email: string; p_operator_name: string };
        Returns: string;
      };
      cpo_create_invite: {
        Args: {
          p_operator_id: string;
          p_email: string;
          p_role: string;
          p_token_hash: string;
          p_invited_by: string;
          p_expires_at: Timestamp;
        };
        Returns: string;
      };
      cpo_accept_invite: {
        Args: { p_token_hash: string; p_user_id: string; p_email: string };
        Returns: string;
      };
      cpo_take_rate_limit: {
        Args: { bucket_key: string; quota: number; period_seconds: number };
        Returns: boolean;
      };
      cpo_my_operator_ids: { Args: Record<string, never>; Returns: string[] };
      cpo_set_staff_role: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_actor_role: string;
          p_user_id: string;
          p_expected_role: string;
          p_role: string;
        };
        Returns: undefined;
      };
      cpo_remove_staff: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_actor_role: string;
          p_user_id: string;
          p_expected_role: string;
        };
        Returns: undefined;
      };
      cpo_save_company: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_name: string;
          p_support_email: string;
          p_support_url: string | null;
          p_website: string | null;
          p_time_zone: string;
          p_currency: string;
        };
        Returns: undefined;
      };
      cpo_save_brand: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_primary_color: string | null;
        };
        Returns: undefined;
      };
      cpo_record_branding: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_hash: string | null;
          p_logo_url: string | null;
          p_logo_uploaded: boolean;
        };
        Returns: undefined;
      };
      cpo_create_charger: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_name: string;
          p_label: string | null;
          p_location_id: number | null;
          p_new_site: Json | null;
          p_connectors: number;
          p_station_id: number | null;
          p_connection_url: string | null;
        };
        Returns: string;
      };
      cpo_update_charger: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_id: string;
          p_changes: Json;
        };
        Returns: undefined;
      };
      cpo_next_charger_seq: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_id: string;
          p_kind: string;
        };
        Returns: number;
      };
      cpo_claim_charger_test: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_id: string;
          p_test: Json;
        };
        Returns: number;
      };
      cpo_add_sticker_codes: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_charger_id: string;
          p_codes: Json;
        };
        Returns: undefined;
      };
      cpo_remove_charger: {
        Args: { p_operator_id: string; p_actor_id: string; p_id: string };
        Returns: undefined;
      };
      cpo_claim_live_command: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_request_id: string;
          p_station_id: number;
          p_action: string;
          p_connector_id: number | null;
          p_transaction_id: number | null;
          p_mode: string | null;
          p_confirmed_sessions: number[];
        };
        Returns: Json;
      };
      cpo_record_live_command: {
        Args: { p_operator_id: string; p_id: string; p_changes: Json };
        Returns: boolean;
      };
      cpo_advance_transaction_mark: {
        Args: { p_station_id: number; p_transaction_id: number };
        Returns: undefined;
      };
      cpo_record_ivora_event: {
        Args: { p_id: string; p_type: string; p_station_id: number | null };
        Returns: boolean;
      };
      cpo_create_tariff: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_name: string;
          p_definition: Json;
        };
        Returns: string;
      };
      cpo_add_tariff_version: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_tariff_id: string;
          p_expected_revision: number;
          p_name: string;
          p_definition: Json;
        };
        Returns: number;
      };
      cpo_next_tariff_attempt: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_tariff_id: string;
          p_version: number;
        };
        Returns: number;
      };
      cpo_record_tariff_version: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_tariff_id: string;
          p_version: number;
          p_ivora_tariff_id: number;
        };
        Returns: undefined;
      };
      cpo_drop_tariff_version: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_tariff_id: string;
          p_version: number;
        };
        Returns: undefined;
      };
      cpo_record_tariff_archived: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_tariff_id: string;
          p_version: number;
        };
        Returns: undefined;
      };
      cpo_set_station_pricing: {
        Args: {
          p_operator_id: string;
          p_actor_id: string;
          p_station_id: number;
          p_expected_revision: number;
          p_tariff_id: string | null;
          p_private: boolean;
          p_connectors: Json;
        };
        Returns: undefined;
      };
      cpo_claim_checkout: {
        Args: {
          p_operator_id: string;
          p_request_id: string;
          p_kind: string;
          p_sticker_code: string;
          p_station_id: number;
          p_connector_id: number;
          p_tariff_id: number;
          p_hold_minor: number;
          p_currency: string;
        };
        Returns: Json;
      };
      cpo_record_checkout: {
        Args: { p_operator_id: string; p_id: string; p_changes: Json };
        Returns: boolean;
      };
      cpo_report_checkouts: {
        Args: {
          p_operator_id: string;
          p_from: Timestamp;
          p_to: Timestamp;
          p_station_id: number | null;
          p_status: string;
          p_limit: number;
          p_offset: number;
          p_after_created_at: Timestamp | null;
          p_after_id: string | null;
        };
        Returns: Database["public"]["Tables"]["cpo_checkouts"]["Row"][];
      };
      cpo_report_totals: {
        Args: {
          p_operator_id: string;
          p_from: Timestamp;
          p_to: Timestamp;
          p_station_id: number | null;
          p_status: string;
        };
        Returns: Json;
      };
      cpo_record_checkout_details: {
        Args: {
          p_operator_id: string;
          p_id: string;
          p_started_at: Timestamp | null;
          p_ended_at: Timestamp | null;
          p_energy_wh: number | null;
          p_connector_number: number | null;
          p_stop_reason: string | null;
        };
        Returns: boolean;
      };
      cpo_report_payments_due: {
        Args: { p_limit: number };
        Returns: { id: string; operator_id: string; payment_id: string }[];
      };
      cpo_record_checkout_payment: {
        Args: {
          p_operator_id: string;
          p_id: string;
          p_captured_minor: number;
          p_refunded_minor: number;
        };
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
