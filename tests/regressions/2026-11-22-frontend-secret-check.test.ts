// 2026-11-22: the front-end secrets check (scripts/check-frontend.mjs) missed three leaks:
// - a Supabase service-role key under an innocent name (VITE_SUPABASE_KEY). The key is a JWT, so
//   the words "service_role" are base64-encoded inside it and never appear as plain text.
// - newer key formats: Anthropic, OpenAI project and service-account keys, Stripe restricted
//   keys and Supabase's newer secret keys.
// - secret-like NEXT_PUBLIC_ names, which Next.js sends to the browser just like VITE_.
// These tests run the real check against a small temporary project.
//
// Fake keys are assembled at run time, so this file contains no key-shaped text for secret
// scanners or push protection to trip on.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const CHECK = resolve("scripts/check-frontend.mjs");
const made: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "frontend-check-"));
  made.push(dir);
  copyFileSync("budgets.json", join(dir, "budgets.json"));
  const all = {
    ".env.example": "VITE_APP_NAME=Example\n",
    "src/web/main.ts": "console.log('hello');\n",
    "dist/web/assets/index.js": "console.log('hello');\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function runCheck(dir: string): { passed: boolean; output: string } {
  try {
    const out = execFileSync("node", [CHECK], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    return { passed: true, output: out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { passed: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: object) =>
  [b64url({ alg: "HS256", typ: "JWT" }), b64url(payload), "c2lnbmF0dXJl"].join(".");
const bundle = (value: string) => ({
  "dist/web/assets/index.js": `const client = createClient("https://x.supabase.co", "${value}");\n`,
});

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("front-end secrets check", () => {
  test("a clean project passes", () => {
    expect(runCheck(project({})).passed).toBe(true);
  });

  test("a Supabase service-role key in the bundle fails, whatever it was called", () => {
    const key = jwt({ iss: "supabase", ref: "abcd", role: ["service", "role"].join("_") });
    const result = runCheck(project(bundle(key)));
    expect(result.passed).toBe(false);
    expect(result.output).toContain("a Supabase service-role key");
  });

  test("the Supabase anon key, which is meant to be public, still passes", () => {
    const key = jwt({ iss: "supabase", ref: "abcd", role: "anon" });
    expect(runCheck(project(bundle(key))).passed).toBe(true);
  });

  test.each([
    ["an Anthropic API key", ["sk", "ant", "api03", "A".repeat(40)].join("-")],
    ["an OpenAI API key", ["sk", "proj", "B".repeat(40)].join("-")],
    ["an OpenAI API key", ["sk", "svcacct", "C".repeat(40)].join("-")],
    ["a Stripe restricted key", ["rk", "live", "D".repeat(24)].join("_")],
    ["a Supabase secret key", ["sb", "secret", "E".repeat(32)].join("_")],
  ])("%s in the bundle fails", (what, key) => {
    const result = runCheck(project(bundle(key)));
    expect(result.passed).toBe(false);
    expect(result.output).toContain(what);
  });

  test("a secret-like NEXT_PUBLIC_ name fails, like a VITE_ one", () => {
    const name = ["NEXT", "PUBLIC", "STRIPE", "SECRET", "KEY"].join("_");
    const result = runCheck(project({ ".env.example": `${name}=replace-me\n` }));
    expect(result.passed).toBe(false);
    expect(result.output).toContain(name);
  });
});
