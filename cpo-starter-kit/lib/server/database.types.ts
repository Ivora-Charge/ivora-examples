// Types for the tables and functions in supabase/migrations, in the shape that
// `supabase gen types typescript` produces. Update them with each migration.

type Timestamp = string;

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
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
