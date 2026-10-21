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
      cpo_record_ivora_event: {
        Args: { p_id: string; p_type: string; p_station_id: number | null };
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
