import { defineConfig } from "vitest/config";

// Tests run from the repo root (vite.config.ts points Vite at src/web for the browser build).
export default defineConfig({
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test file starts its own in-process Postgres (PGlite). On a busy CI runner that
    // can take several seconds, and Vitest's 5-second default made tests fail at random.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
