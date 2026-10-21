import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// `npm run screenshots` (after `npm run build`): regenerates docs/screens.
export default defineConfig({
  ...base,
  testDir: "scripts",
  testMatch: "screens.ts",
});
