import "server-only";
import { config, isDemo } from "../env";
import { demoTariffLookup } from "../pricing/demo-tariffs";
import { createDemoClient } from "./demo";
import { cookieDemoFleet, resetDemoFleetForTests } from "./demo-cookie";
import { cookieDemoOcpi, resetDemoOcpiForTests } from "./demo-ocpi-cookie";
import { createLiveClient } from "./live";
import type { IvoraClient } from "./types";

export {
  describeError,
  ERRORS_URL,
  IvoraError,
  tariffProblems,
} from "./errors";
export type * from "./types";

const g = globalThis as unknown as {
  __cpoIvora?: { demo?: IvoraClient; live?: IvoraClient; liveFor?: string };
};
const cache = () => (g.__cpoIvora ??= {});

/**
 * The one place that picks the client. In demo mode (credentials missing, or
 * DEMO_MODE=true) every module gets the demo client, which never sends a request.
 * The live client also refuses to send while demo mode is on.
 */
export function getIvora(): IvoraClient {
  const c = cache();
  // The demo client keeps each visitor's own chargers and roaming settings in cookies.
  if (isDemo())
    return (c.demo ??= createDemoClient(
      cookieDemoFleet(),
      Date.now,
      demoTariffLookup,
      { ocpi: cookieDemoOcpi() },
    ));
  const liveFor = `${config.apiBaseUrl}|${config.tenantId}|${config.apiKey}`;
  if (!c.live || c.liveFor !== liveFor) {
    c.live = createLiveClient({
      baseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      tenantId: config.tenantId,
    });
    c.liveFor = liveFor;
  }
  return c.live;
}

/** Forget cached clients (tests change the environment between cases). */
export function resetIvoraForTests() {
  delete g.__cpoIvora;
  resetDemoFleetForTests();
  resetDemoOcpiForTests();
}

/**
 * Idempotency-Key for an Ivora write, derived from our own record and action, for
 * example `idempotencyKey("location", site.id, "create")`. A retry of the same action
 * on the same record gets the same key, so it cannot happen twice.
 */
export function idempotencyKey(
  record: string,
  id: string | number,
  action: string,
): string {
  const key = `cpo-${record}-${id}-${action}`;
  if (!/^[\x21-\x7e]{8,128}$/.test(key))
    throw new Error("Idempotency key must be 8-128 printable ASCII characters");
  return key;
}
