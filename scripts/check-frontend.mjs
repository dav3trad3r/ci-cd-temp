// Front-end checks, run after `npm run build`:
// 1. No secrets in the files sent to the browser.
// 2. No VITE_ variable named like a secret (anything VITE_ is readable by every visitor).
// 3. Bundle-size budget: browser JavaScript must stay under budgets.json (a performance
//    regression check).
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const WEB_DIR = "dist/web";
const problems = [];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

try {
  await stat(WEB_DIR);
} catch {
  console.error(`${WEB_DIR} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

// 1. Secrets in the browser bundle
const SECRET_PATTERNS = [
  [/sk_live_[0-9A-Za-z]{8,}/, "a Stripe live secret key"],
  [/service_role/, "a Supabase service-role key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key"],
  [/gh[pousr]_[0-9A-Za-z]{30,}/, "a GitHub token"],
  [/xox[abprs]-[0-9A-Za-z-]{10,}/, "a Slack token"],
  [/APP_JWT_SECRET|DATABASE_URL/, "a server-only setting name"],
];
const files = await walk(WEB_DIR);
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`${file} contains ${what}.`);
  }
}

// 2. VITE_ variables named like secrets, in the example env file and the browser source
const SECRET_NAME =
  /\bVITE_[A-Z0-9_]*(SECRET|PRIVATE|PASSWORD|TOKEN|SERVICE_ROLE|API_KEY)[A-Z0-9_]*/g;
const sources = [".env.example", ...(await walk("src/web"))];
for (const file of sources) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  for (const match of text.matchAll(SECRET_NAME)) {
    problems.push(
      `${file} uses ${match[0]}: VITE_ values are public, so keep secrets on the server.`,
    );
  }
}

// 3. Bundle-size budget
const { webJsKbGzip } = JSON.parse(await readFile("budgets.json", "utf8"));
let jsBytes = 0;
for (const file of files.filter((f) => f.endsWith(".js"))) {
  jsBytes += gzipSync(await readFile(file)).length;
}
const jsKb = jsBytes / 1024;
console.log(`Browser JavaScript: ${jsKb.toFixed(1)} KB gzip (budget ${webJsKbGzip} KB).`);
if (jsKb > webJsKbGzip) {
  problems.push(
    `Browser JavaScript is ${jsKb.toFixed(1)} KB gzip, over the ${webJsKbGzip} KB budget in budgets.json.`,
  );
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ ${files.length} browser files checked: no secrets, no secret-like VITE_ names, within budget.`,
);
