import "server-only";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { cookieDemoOcpi } from "../ivora/demo-ocpi-cookie";
import type { RoamingDeps } from "./service";

export * from "./service";
export { RoamingError } from "./types";
export type * from "./types";

/**
 * The one place that picks what Roaming talks to. In demo mode it is the demo Ivora
 * client, whose OCPI settings live in the visitor's cookie: nothing reaches Ivora.
 */
export function getRoaming(): RoamingDeps {
  return {
    ivora: getIvora(),
    demoOcpi: isDemo() ? cookieDemoOcpi() : null,
  };
}
