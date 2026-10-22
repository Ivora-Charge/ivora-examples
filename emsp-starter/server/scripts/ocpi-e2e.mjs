// Runs the OCPI e2e suite (tests/e2e). `npm run test:ocpi-e2e` loads .env.e2e.local
// first, if there is one. Without OCPI_E2E_VERSIONS_URL it runs against the mock CPO,
// offline, as CI does; with it, against that CPO's sandbox (tests/e2e/lanes.ts checks
// the rest). Prints variable names only, never values.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const real = !!process.env.OCPI_E2E_VERSIONS_URL?.trim();
console.log(
  real
    ? `OCPI e2e: real CPO lane (OCPI_E2E_VERSIONS_URL is set; OCPI_E2E_EXPECT_START is ${process.env.OCPI_E2E_EXPECT_START?.trim() ? "set" : "not set, so rejected"})`
    : "OCPI e2e: mock CPO lane (OCPI_E2E_VERSIONS_URL is not set)",
);

const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    "--config",
    "vitest.e2e.config.mts",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", cwd: fileURLToPath(new URL("..", import.meta.url)) },
);
process.exit(result.status ?? 1);
