import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "json-summary"],
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
