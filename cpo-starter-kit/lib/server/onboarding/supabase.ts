import "server-only";
import { serviceClient } from "../supabase";
import {
  emptyProfile,
  noCompany,
  notAllowed,
  type CompanyProfile,
  type OnboardingStore,
} from "./types";

type DbError = { message: string; code?: string } | null;

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  if (r.error.message.includes("cpo_not_allowed")) throw notAllowed();
  if (r.error.message.includes("cpo_no_company")) throw noCompany();
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

/**
 * The company profile in Supabase (cpo_company_profiles). Service role only, for the
 * operator of the signed-in staff member; writes go through functions that check the
 * actor is still an owner or manager in the same statement.
 */
export function createSupabaseOnboardingStore(): OnboardingStore {
  const svc = () => serviceClient();
  const rpc = async (
    ...a: Parameters<ReturnType<typeof serviceClient>["rpc"]>
  ) => {
    check(await svc().rpc(...a));
  };
  return {
    mode: "live",
    async load(operatorId) {
      const { data } = check(
        await svc()
          .from("cpo_company_profiles")
          .select(
            "name, support_email, support_url, website, time_zone, currency, primary_color, logo_url, branding_hash, branding_synced_at, branding_syncs, logo_uploads",
          )
          .eq("operator_id", operatorId)
          .maybeSingle(),
      );
      if (!data) return emptyProfile();
      return {
        name: data.name,
        supportEmail: data.support_email,
        supportUrl: data.support_url,
        website: data.website,
        timeZone: data.time_zone,
        currency: data.currency,
        primaryColor: data.primary_color,
        logoUrl: data.logo_url,
        brandingHash: data.branding_hash,
        brandingSyncedAt: data.branding_synced_at,
        brandingSyncs: data.branding_syncs,
        logoUploads: data.logo_uploads,
      } satisfies CompanyProfile;
    },
    saveCompany(actor, i) {
      return rpc("cpo_save_company", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_name: i.name,
        p_support_email: i.supportEmail,
        p_support_url: i.supportUrl,
        p_website: i.website,
        p_time_zone: i.timeZone,
        p_currency: i.currency,
      });
    },
    saveBrand(actor, primaryColor) {
      return rpc("cpo_save_brand", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_primary_color: primaryColor,
      });
    },
    recordBranding(actor, r) {
      return rpc("cpo_record_branding", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_hash: r.hash,
        p_logo_url: r.logoUrl,
        p_logo_uploaded: r.logoUploaded,
      });
    },
  };
}
