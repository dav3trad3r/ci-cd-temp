import { defineConfig } from "vitest/config";

// Tests run from the repo root (vite.config.ts points Vite at src/web for the browser build).
export default defineConfig({
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
