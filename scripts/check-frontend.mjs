// Front-end checks, run after `npm run build`:
// 1. No secrets in the files sent to the browser, including Supabase service-role keys hidden
//    inside JWTs.
// 2. No VITE_, NEXT_PUBLIC_ or REACT_APP_ variable named like a secret (all are readable by every visitor).
// Tested in tests/regressions/2026-11-22-frontend-secret-check.test.ts.
// 3. Bundle-size budget: browser JavaScript must stay under budgets.json (a performance
//    regression check).
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// The folder of built browser files. The platform passes each tool's own (dist, build, .next/static).
const WEB_DIR = process.env.FRONTEND_WEB_DIR || "dist/web";
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
  [/rk_live_[0-9A-Za-z]{8,}/, "a Stripe restricted key"],
  [/service_role/, "a Supabase service-role key"],
  [/sb_secret_[0-9A-Za-z_-]{16,}/, "a Supabase secret key"],
  [/sk-ant-[0-9A-Za-z_-]{20,}/, "an Anthropic API key"],
  [/sk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{20,}/, "an OpenAI API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key"],
  [/gh[pousr]_[0-9A-Za-z]{30,}/, "a GitHub token"],
  [/xox[abprs]-[0-9A-Za-z-]{10,}/, "a Slack token"],
  [/APP_JWT_SECRET|DATABASE_URL/, "a server-only setting name"],
];
// Not checked on purpose: Google keys starting AIza (Firebase web keys are public by design;
// restrict them in Google Cloud instead) and Azure keys, which have no recognisable shape
// (use managed identities so tools never hold one).

// A Supabase service-role key is a JWT, so the words "service_role" are base64-encoded inside
// it and never appear as plain text. Decode every JWT in the bundle and read its role.
const JWT = /eyJ[0-9A-Za-z_-]{8,}\.(eyJ[0-9A-Za-z_-]{8,})\.[0-9A-Za-z_-]*/g;
function jwtRoles(text) {
  const roles = [];
  for (const [, payload] of text.matchAll(JWT)) {
    try {
      roles.push(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role);
    } catch {
      // Not a JWT after all.
    }
  }
  return roles;
}

const files = await walk(WEB_DIR);
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(text)) problems.push(`${file} contains ${what}.`);
  }
  if (jwtRoles(text).includes("service_role")) {
    problems.push(
      `${file} contains a Supabase service-role key (a JWT whose role is service_role).`,
    );
  }
}

// 2. Public variables named like secrets: VITE_ (Vite), NEXT_PUBLIC_ (Next.js) and REACT_APP_
//    (Create React App) are all sent to the browser. Checked in the example env file and the front-end source.
const SECRET_NAME =
  /\b(?:VITE|NEXT_PUBLIC)_[A-Z0-9_]*(SECRET|PRIVATE|PASSWORD|TOKEN|SERVICE_ROLE|API_KEY)[A-Z0-9_]*/g;
async function walkIfPresent(dir) {
  try {
    return await walk(dir);
  } catch {
    return [];
  }
}
const sources = [
  ".env.example",
  ...(await walkIfPresent("src")),
  ...(await walkIfPresent("app")),
  ...(await walkIfPresent("pages")),
];
for (const file of sources) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  for (const match of text.matchAll(SECRET_NAME)) {
    problems.push(
      `${file} uses ${match[0]}: VITE_, NEXT_PUBLIC_ and REACT_APP_ values are sent to every visitor, so keep secrets on the server.`,
    );
  }
}

// 3. Bundle-size budget
// A migrated tool may not have a budget yet: then the size is reported but not limited.
let webJsKbGzip;
try {
  ({ webJsKbGzip } = JSON.parse(await readFile("budgets.json", "utf8")));
} catch {
  webJsKbGzip = undefined;
}
let jsBytes = 0;
for (const file of files.filter((f) => f.endsWith(".js"))) {
  jsBytes += gzipSync(await readFile(file)).length;
}
const jsKb = jsBytes / 1024;
console.log(
  `Browser JavaScript: ${jsKb.toFixed(1)} KB gzip (${webJsKbGzip === undefined ? "no budget set" : `budget ${webJsKbGzip} KB`}).`,
);
if (webJsKbGzip !== undefined && jsKb > webJsKbGzip) {
  problems.push(
    `Browser JavaScript is ${jsKb.toFixed(1)} KB gzip, over the ${webJsKbGzip} KB budget in budgets.json.`,
  );
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ ${files.length} browser files checked: no secrets, no secret-like public variable names, within budget.`,
);
