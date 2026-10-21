import "server-only";
import { config, isDemo } from "../env";
import { ResendMailer } from "../mail";
import { createMemoryLimiter, type RateLimiter } from "../rate-limit";
import { createSupabaseAccounts } from "./accounts";
import { createDemoBackend } from "./demo";
import { cookieDemoStore } from "./demo-cookie";
import type { TeamDeps } from "./service";
import { createSupabaseBackend, createSupabaseLimiter } from "./supabase";

export * from "./service";
export { TeamError } from "./types";
export type { Member, PendingInvite, Staff } from "./types";

const g = globalThis as unknown as { __cpoDemoLimiter?: RateLimiter };

/**
 * The one place that picks the team backend. In demo mode (see isDemo()) it is the
 * cookie-backed sample team with no accounts and no mailer, so nothing reaches
 * Supabase, an email provider or any other service. The Supabase clients also refuse
 * to run while demo mode is on.
 */
export function getTeam(): TeamDeps {
  const now = () => new Date();
  if (isDemo())
    return {
      backend: createDemoBackend(cookieDemoStore(), config.operatorName),
      accounts: null,
      limiter: (g.__cpoDemoLimiter ??= createMemoryLimiter()),
      secret: "demo-mode",
      mailer: null,
      appUrl: config.appUrl,
      setupSecret: "",
      now,
    };
  const mailer =
    config.resendApiKey && config.emailFrom
      ? new ResendMailer(config.resendApiKey, config.emailFrom)
      : null;
  return {
    backend: createSupabaseBackend(),
    accounts: createSupabaseAccounts(mailer, () => config.operatorName),
    limiter: createSupabaseLimiter(),
    secret: config.supabaseServiceRoleKey,
    mailer,
    appUrl: config.appUrl,
    setupSecret: config.setupSecret,
    now,
  };
}
