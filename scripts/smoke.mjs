// Smoke test: start the built server, check it answers, then stop it.
// Run after `npm run build`. The deploy workflow for your host should run the same
// checks against the live address once it has deployed.
import { spawn } from "node:child_process";

const port = process.env.SMOKE_PORT ?? "8099";
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["dist/server/index.js"], {
  env: { ...process.env, PORT: port, NODE_ENV: "development" },
  stdio: ["ignore", "inherit", "inherit"],
});

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
}

let ok = false;
try {
  for (let i = 0; i < 40 && !ok; i++) {
    try {
      const health = await get("/healthz");
      ok = health.status === 200;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ok) throw new Error("the server never answered /healthz");

  const home = await get("/");
  if (home.status !== 200 || !home.body.includes("<html")) {
    throw new Error(`the home page answered ${home.status}`);
  }
  const api = await get("/api/items");
  if (api.status !== 401) throw new Error(`/api/items answered ${api.status} without sign-in`);

  console.log(
    "✓ Smoke test passed: health check, home page, and the API refuses anonymous requests.",
  );
} catch (err) {
  console.error(`✗ Smoke test failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
}
