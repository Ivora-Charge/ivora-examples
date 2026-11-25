// The last step of `npm run build` (and build:one-domain): applies pending migrations
// with the same runner as `npm run db:migrate`, on production builds only (README:
// Migrations during the build).
//
//   On Vercel   only when VERCEL_ENV is production. A preview or development build
//               never migrates, whatever else is set.
//   Elsewhere   only when EMSP_MIGRATE_ON_BUILD is on (true, 1, yes or on).
//   Never       when EMSP_MIGRATE_ON_BUILD is off (false, 0, no or off), when DEMO_MODE
//               is on, or without a connection string (the build then passes and Setup
//               names the pending migrations, as without this step).
//
// It runs after `next build`, so code that does not compile never touches the database.
// A failed migration fails the build: the log names the file and the error code, never
// the connection string or a row value, and the previous deployment stays live.
// This script reads the process environment only, never .env files.
import { pathToFileURL } from "node:url";
import { databaseUrl, DB_URL_NAMES, migrate } from "./migrate.mjs";

export const SWITCH = "EMSP_MIGRATE_ON_BUILD";

const ON = new Set(["true", "1", "yes", "on"]);
const OFF = new Set(["false", "0", "no", "off"]);

/** `on`, `off`, `unset` or `invalid`: the value itself is never reported. */
function flag(value) {
  const v = value?.trim().toLowerCase();
  if (!v) return "unset";
  if (ON.has(v)) return "on";
  if (OFF.has(v)) return "off";
  return "invalid";
}

/**
 * Whether this build applies migrations, and why. `{ run: true, database }` or
 * `{ run: false, reason }`, or `{ run: false, error }` when the build must fail.
 */
export function buildMigrationPlan(env) {
  const choice = flag(env[SWITCH]);
  if (choice === "invalid")
    return {
      run: false,
      error: `${SWITCH} is neither on (true, 1, yes, on) nor off (false, 0, no, off).`,
    };
  if (choice === "off") return { run: false, reason: `${SWITCH} is off.` };

  const vercelEnv = env.VERCEL_ENV?.trim();
  if (vercelEnv) {
    if (vercelEnv !== "production")
      return {
        run: false,
        reason: `this is a ${vercelEnv} build (VERCEL_ENV): only production builds migrate.`,
      };
  } else if (env.VERCEL?.trim()) {
    return {
      run: false,
      reason:
        "VERCEL_ENV is not set, so this may not be a production build. Turn on the project's system environment variables.",
    };
  } else if (choice !== "on") {
    return {
      run: false,
      reason: `not a Vercel production build, and ${SWITCH} is not on.`,
    };
  }

  if (flag(env.DEMO_MODE) === "on")
    return { run: false, reason: "DEMO_MODE is on." };

  const database = databaseUrl(env);
  if (!database)
    return {
      run: false,
      reason: `no connection string (${DB_URL_NAMES.join(", ")}). Setup lists the pending migrations.`,
    };
  return { run: true, database };
}

/**
 * Runs the plan for `env`. Returns the exit code: 0 when migrations were applied or
 * skipped, 1 when the build must fail.
 */
export async function runBuildMigrations(
  env,
  { apply = migrate, log = console.log, error = console.error } = {},
) {
  const plan = buildMigrationPlan(env);
  if (plan.error) {
    error(`Build-time migrations: ${plan.error}`);
    return 1;
  }
  if (!plan.run) {
    log(`Build-time migrations skipped: ${plan.reason}`);
    return 0;
  }
  log("Build-time migrations: applying pending migrations.");
  try {
    await apply(plan.database, { log });
    return 0;
  } catch (e) {
    // MigrationError messages hold the file name and error code only. Anything else
    // is reported without its message, which could echo connection details.
    error(
      e?.name === "MigrationError"
        ? e.message
        : "Migration failed: connection error.",
    );
    error(
      "The build fails, so the previous deployment stays live. Fix the migration or the connection string and deploy again.",
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runBuildMigrations(process.env);
