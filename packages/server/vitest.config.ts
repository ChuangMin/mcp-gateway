import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/support/postgres.global-setup.ts"],
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
