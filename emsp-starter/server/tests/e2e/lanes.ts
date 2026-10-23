/**
 * The two lanes of the OCPI e2e suite (ocpi.e2e.ts):
 *
 * - **mock** (the default, and what CI runs): the mock CPO of lib/mock-cpo and a mock
 *   Stripe, over an in-process network. Nothing leaves the process. Runs every
 *   scenario: a CPO that accepts remote starts and one that rejects them.
 * - **real**: any OCPI 2.2.1 CPO's sandbox, from OCPI_E2E_VERSIONS_URL and
 *   OCPI_E2E_TOKEN_A, with Stripe in test mode. Only when those are set, never in
 *   public CI. See "End-to-end tests against a CPO" in the README.
 *
 * Settings are read here, by name. Values are never printed.
 */

export type ExpectStart = "accepted" | "rejected";

export type RealSettings = {
  versionsUrl: string;
  tokenA: string;
  /** The https:// origin the CPO reaches this run at (a tunnel to `listenPort`). */
  publicUrl: string;
  listenPort: number;
  expectStart: ExpectStart;
  /** The CPO's location (and optionally EVSE and connector) to start at. */
  target: { locationId?: string; evseUid?: string; connectorId?: string };
  /** How long to let the car charge before STOP_SESSION. */
  chargeMs: number;
  /** How long to wait for each answer or push of the CPO. */
  waitMs: number;
  driverEmail: string;
  /** Leave the registration at the CPO in place after the run. */
  keepRegistration: boolean;
};

export type Lane =
  | { kind: "mock"; scenarios: ExpectStart[] }
  | { kind: "real"; scenarios: [ExpectStart]; settings: RealSettings };

const env = (name: string) => process.env[name]?.trim() || undefined;

/** Variables the real lane needs, by name. */
export const REAL_REQUIRED = [
  "OCPI_E2E_VERSIONS_URL",
  "OCPI_E2E_TOKEN_A",
  "OCPI_E2E_PUBLIC_URL",
  "EMSP_COUNTRY_CODE",
  "EMSP_PARTY_ID",
  "STRIPE_SECRET_KEY",
] as const;

function seconds(name: string, fallback: number): number {
  const v = env(name);
  if (!v) return fallback * 1000;
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1)
    throw new Error(`${name} must be a whole number of seconds`);
  return Number(v) * 1000;
}

export function expectStartOf(v: string | undefined): ExpectStart {
  const value = (v ?? "rejected").trim().toLowerCase();
  if (value !== "accepted" && value !== "rejected")
    throw new Error("OCPI_E2E_EXPECT_START must be accepted or rejected");
  return value;
}

/**
 * The lane to run. The real lane runs only when OCPI_E2E_VERSIONS_URL is set, and
 * then every variable it needs must be set and valid: a half-configured run fails
 * instead of quietly testing the mock.
 */
export function laneFromEnv(): Lane {
  if (!env("OCPI_E2E_VERSIONS_URL"))
    return { kind: "mock", scenarios: ["accepted", "rejected"] };

  // Real CPO credentials never belong in public CI.
  if ((env("CI") || env("GITHUB_ACTIONS")) && env("OCPI_E2E_ALLOW_CI") !== "1")
    throw new Error(
      "Refusing to run against a real CPO in CI. Set OCPI_E2E_ALLOW_CI=1 only in a private pipeline.",
    );
  const missing = REAL_REQUIRED.filter((name) => !env(name));
  if (missing.length)
    throw new Error(`The real lane needs ${missing.join(", ")}`);
  // Never a live key: the suite captures and refunds real money otherwise.
  if (!/^(sk|rk)_test_/.test(env("STRIPE_SECRET_KEY")!))
    throw new Error("STRIPE_SECRET_KEY must be a Stripe test-mode key");

  let publicUrl: URL;
  try {
    publicUrl = new URL(env("OCPI_E2E_PUBLIC_URL")!);
  } catch {
    throw new Error("OCPI_E2E_PUBLIC_URL must be an https:// origin");
  }
  if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/")
    throw new Error(
      "OCPI_E2E_PUBLIC_URL must be an https:// origin, without a path",
    );
  const port = env("OCPI_E2E_LISTEN_PORT") ?? "3318";
  if (!/^\d{2,5}$/.test(port) || Number(port) > 65535)
    throw new Error("OCPI_E2E_LISTEN_PORT must be a port number");

  const expectStart = expectStartOf(env("OCPI_E2E_EXPECT_START"));
  return {
    kind: "real",
    scenarios: [expectStart],
    settings: {
      versionsUrl: env("OCPI_E2E_VERSIONS_URL")!,
      tokenA: env("OCPI_E2E_TOKEN_A")!,
      publicUrl: publicUrl.origin,
      listenPort: Number(port),
      expectStart,
      target: {
        locationId: env("OCPI_E2E_LOCATION_ID"),
        evseUid: env("OCPI_E2E_EVSE_UID"),
        connectorId: env("OCPI_E2E_CONNECTOR_ID"),
      },
      chargeMs: seconds("OCPI_E2E_CHARGE_SECONDS", 60),
      waitMs: seconds("OCPI_E2E_TIMEOUT_SECONDS", 300),
      driverEmail: env("OCPI_E2E_DRIVER_EMAIL") ?? "e2e-driver@example.com",
      keepRegistration: env("OCPI_E2E_KEEP_REGISTRATION") === "1",
    },
  };
}
