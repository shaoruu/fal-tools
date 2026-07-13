import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@fal-tools/audio": path.resolve("packages/audio/src/index.ts"),
      "@fal-tools/core": path.resolve("packages/core/src/index.ts"),
      "@fal-tools/image": path.resolve("packages/image/src/index.ts"),
      "@fal-tools/provider-fal": path.resolve(
        "packages/provider-fal/src/index.ts",
      ),
    },
  },
  test: {
    coverage: {
      include: ["packages/*/src/**/*.ts"],
      provider: "v8",
    },
    include: ["packages/*/test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20_000,
  },
});
