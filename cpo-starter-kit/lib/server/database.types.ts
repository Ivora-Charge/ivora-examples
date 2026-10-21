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
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
