import { defineConfig } from "vite";

// The browser app lives in src/web and builds to dist/web, which the server serves.
// Only variables prefixed VITE_ reach the browser, and scripts/check-frontend.mjs
// fails the build if one of them is named like a secret.
export default defineConfig({
  root: "src/web",
  envDir: "../..",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
