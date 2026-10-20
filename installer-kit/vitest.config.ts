import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // server-only throws outside a React Server Components build.
      "server-only": path.resolve(import.meta.dirname, "tests/server-only.ts"),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
