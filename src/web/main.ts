// Only VITE_ variables reach the browser. Never put a secret in one:
// scripts/check-frontend.mjs fails the build if a VITE_ name looks like a secret.
const appName = import.meta.env.VITE_APP_NAME ?? "CI/CD template";

const nameEl = document.getElementById("name");
if (nameEl) nameEl.textContent = appName;

const statusEl = document.getElementById("status");
fetch("/healthz")
  .then((res) => (res.ok ? "running" : `error ${res.status}`))
  .catch(() => "unreachable")
  .then((text) => {
    if (statusEl) statusEl.textContent = text;
  });
