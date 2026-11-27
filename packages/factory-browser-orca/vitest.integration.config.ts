import { defineConfig } from "vitest/config";

// Drives the real Orca app against a local test site. Opt in with
// FACTORY_ORCA_INTEGRATION=1; it needs Orca running and the
// "AI Content Factory" profile.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
});
