import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Property tests run 100+ cases each; give them room.
    testTimeout: 20_000,
    setupFiles: ["tests/setup.ts"],
    // Builds the throwaway Postgres schema the repository tests use.
    globalSetup: ["tests/global-setup.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
