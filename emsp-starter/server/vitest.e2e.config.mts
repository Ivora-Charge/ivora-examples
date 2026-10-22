import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The OCPI e2e suite (tests/e2e): the mock CPO by default, a real CPO's sandbox when
// OCPI_E2E_VERSIONS_URL is set. Run it with `npm run test:ocpi-e2e`.
const real = !!process.env.OCPI_E2E_VERSIONS_URL?.trim();

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` throws outside a React server bundle; tests run in plain Node.
      "server-only": fileURLToPath(
        new URL("./tests/support/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    // A real charger takes minutes; each wait has its own limit (OCPI_E2E_TIMEOUT_SECONDS).
    testTimeout: real ? 60 * 60_000 : 30_000,
    hookTimeout: real ? 10 * 60_000 : 30_000,
    // One CPO, one run at a time.
    fileParallelism: false,
  },
});
