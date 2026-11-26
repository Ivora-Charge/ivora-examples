import { defineConfig } from "vitest/config";

/**
 * Two sets of tests. `unit`: plain TypeScript modules in Node. `web`: screens (`.tsx`
 * tests) rendered as the web build renders them, with React Native Web in a simulated
 * DOM, and each module's `.web` file where it has one.
 */
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/**/*.test.ts"] } },
      {
        resolve: {
          alias: { "react-native": "react-native-web" },
          // The web files first, then Vite's own defaults.
          extensions: [
            ".web.tsx",
            ".web.ts",
            ".mjs",
            ".js",
            ".mts",
            ".ts",
            ".jsx",
            ".tsx",
            ".json",
          ],
        },
        test: {
          name: "web",
          include: ["tests/**/*.test.tsx"],
          environment: "happy-dom",
        },
      },
    ],
  },
});
