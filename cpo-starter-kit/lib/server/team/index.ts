import "server-only";
import { config, isDemo } from "../env";
import { ResendMailer } from "../mail";
import { createMemoryLimiter, type RateLimiter } from "../rate-limit";
import { createSupabaseAccounts } from "./accounts";
import { createDemoBackend, DEMO_OPERATOR_ID } from "./demo";
import { cookieDemoStore } from "./demo-cookie";
import type { TeamDeps } from "./service";
import { createSupabaseBackend, createSupabaseLimiter } from "./supabase";
import { createDemoHostStore } from "../hosts/demo";
import { cookieDemoHosts } from "../hosts/demo-cookie";
import { hostAccessOf } from "../hosts/service";
import { createSupabaseHostStore } from "../hosts/supabase";
import type { HostStore } from "../hosts/types";

/** The host's name while it is active, for host invites. */
const activeHostIn =
  (store: () => HostStore) => async (operatorId: string, hostId: string) =>
    (await store().list(operatorId)).find(
      (h) => h.id === hostId && !h.archivedAt,
    )?.name ?? null;

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
const demoHosts = () =>
  createDemoHostStore(cookieDemoHosts(), cookieDemoStore());

export function getTeam(): TeamDeps {
  const now = () => new Date();
  if (isDemo())
    return {
      backend: createDemoBackend(
        cookieDemoStore(),
        config.operatorName,
        now,
        async (hostId) => {
          const hosts = demoHosts();
          const [list, sites] = await Promise.all([
            hosts.list(DEMO_OPERATOR_ID),
            hosts.sites(DEMO_OPERATOR_ID),
          ]);
          return hostAccessOf(list, sites, hostId);
        },
      ),
      accounts: null,
      limiter: (g.__cpoDemoLimiter ??= createMemoryLimiter()),
      secret: "demo-mode",
      mailer: null,
      appUrl: config.appUrl,
      setupSecret: "",
      now,
      activeHost: activeHostIn(demoHosts),
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
    activeHost: activeHostIn(createSupabaseHostStore),
  };
}
