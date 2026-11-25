import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * What this server's one origin serves (README: One domain).
 *
 * - /admin (Setup and every admin page), /api and /ocpi are this server's own.
 * - With the driver app's web build in public/ (`npm run build:one-domain`), every
 *   other path is the app's: its files as they are, and its index.html for the rest,
 *   so a link such as /account opens the app.
 * - Without it, / leads to /admin, and the app is deployed on an origin of its own.
 *
 * Which of the two a build is gets fixed when it is built.
 */

/** Written by scripts/driver-web.mjs: the app's web build is in public/. */
const hasDriverWeb = existsSync(join(__dirname, ".driver-web.json"));

/** Every path whose first segment is not the server's own. */
export const NOT_THE_SERVERS = "/:path((?!(?:admin|api|ocpi|_next)(?:/|$)).*)";

/**
 * What a browser is told about a page: no site may frame it, its type is not to be
 * guessed, and how much of its address other requests may carry. Each path gets one of
 * the two sets, never both, so neither weakens the other.
 */
const securityHeaders = (referrerPolicy: string) => [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: referrerPolicy },
];

/** The admin's pages never send their path or query on, to this origin either. */
export const ADMIN_HEADERS = securityHeaders("strict-origin");
/**
 * The driver app's pages, as its own vercel.json has them: map providers that restrict
 * a key by referrer need the origin. The rest of the app's policy is the <meta> tag
 * its build puts in index.html (app/scripts/csp.mjs).
 */
export const DRIVER_HEADERS = securityHeaders(
  "strict-origin-when-cross-origin",
);

/**
 * The API and OCPI answer programs, and their answers carry none of these. A browser
 * that opens a wrong address there is shown the admin's 404 page, which gets the
 * admin's headers: matched by what only a page load asks for.
 */
const A_PAGE_LOAD = [
  { type: "header" as const, key: "accept", value: ".*text/html.*" },
];

export function webConfig(driverWeb: boolean): NextConfig {
  return {
    poweredByHeader: false,
    async headers() {
      return [
        { source: "/admin/:path*", headers: ADMIN_HEADERS },
        { source: "/_next/:path*", headers: ADMIN_HEADERS },
        {
          source: NOT_THE_SERVERS,
          headers: driverWeb ? DRIVER_HEADERS : ADMIN_HEADERS,
        },
        ...["/api/:path*", "/ocpi/:path*"].map((source) => ({
          source,
          has: A_PAGE_LOAD,
          headers: ADMIN_HEADERS,
        })),
      ];
    },
    async redirects() {
      // Temporary: a later build may have the app at /.
      return driverWeb
        ? []
        : [{ source: "/", destination: "/admin", permanent: false }];
    },
    async rewrites() {
      return {
        beforeFiles: [],
        afterFiles: [],
        // After every file and route: only what nothing else answers.
        fallback: driverWeb
          ? [{ source: NOT_THE_SERVERS, destination: "/index.html" }]
          : [],
      };
    },
  };
}

export default webConfig(hasDriverWeb);
