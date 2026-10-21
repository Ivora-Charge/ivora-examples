import { defineConfig } from "vitest/config";

// Unit tests cover plain TypeScript modules (no React Native rendering) in Node.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
