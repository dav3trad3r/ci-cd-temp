// Proves both ways onto the platform work, from scratch, on every change to the platform:
// a new tool passes everything, and a messy existing tool can migrate without being blocked by
// its past, while a leaked key, a new problem or exposed data is still caught.
//   npm run tool:selftest     (needs Gitleaks: set GITLEAKS_BIN or have it on the PATH)
// Runs entirely in a temporary folder and leaves this repository untouched.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Baseline } from "./baseline.js";
import { loadRegistry, PLATFORM_ROOT, registrySchema } from "./model.js";
import { gitleaksBin } from "./secrets.js";
import { applyFix } from "../sre/apply-fix.js";
import type { FixProposal } from "../sre/fix.js";

// The self-test pushes only to a local folder, and must never reach a real repository.
delete process.env.GITHUB_TOKEN;
delete process.env.SRE_AGENT_GITHUB_TOKEN;

const work = mkdtempSync(join(tmpdir(), "platform-selftest-"));
const dataRoot = join(work, "platform-data");
mkdirSync(join(dataRoot, "ops"), { recursive: true });
cpSync(join(PLATFORM_ROOT, "ops/platform.json"), join(dataRoot, "ops/platform.json"));

const tsx = join(PLATFORM_ROOT, "node_modules/tsx/dist/cli.mjs");
const tsconfig = join(PLATFORM_ROOT, "tsconfig.json");
const env = { ...process.env, PLATFORM_DATA_ROOT: dataRoot };

function script(file: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [tsx, "--tsconfig", tsconfig, join(PLATFORM_ROOT, "scripts/platform", file), ...args],
    { cwd, env: { ...env, ...extra }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return { code: result.status ?? 1, output: `${result.stdout}\n${result.stderr}` };
}

/** Runs the checks and returns whether they passed and whether the tool may deploy. */
function checks(dir: string) {
  const out = join(work, `output-${randomBytes(4).toString("hex")}`);
  writeFileSync(out, "");
  const result = script("checks.ts", [], dir, { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: "" });
  return { ...result, ready: readFileSync(out, "utf8").includes("ready=true") };
}

const git = (args: string[], cwd: string) =>
  execFileSync(
    "git",
    ["-c", "user.name=Selftest", "-c", "user.email=selftest@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

let failures = 0;
function expectThat(what: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(detail.trim().split("\n").slice(-30).join("\n"));
  }
}

/** A typical staff-built tool: no tests, lint problems, a Supabase table left open. */
function makeMessyTool(dir: string, leakedKey: string) {
  mkdirSync(join(dir, "supabase/migrations"), { recursive: true });
  const put = (path: string, text: string) => writeFileSync(join(dir, path), text);
  put(
    "package.json",
    JSON.stringify(
      {
        name: "messy-tool",
        version: "1.0.0",
        private: true,
        scripts: { lint: "node lint.cjs", start: "node server.js" },
        dependencies: {},
      },
      null,
      2,
    ),
  );
  put(
    "package-lock.json",
    JSON.stringify({
      name: "messy-tool",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "messy-tool", version: "1.0.0" } },
    }),
  );
  // Fails with one problem per line of problems.txt, so a test can add a new one.
  put(
    "lint.cjs",
    [
      'const lines = require("fs").readFileSync("problems.txt", "utf8").trim().split("\\n");',
      "console.log(`✖ ${lines.length} problems`);",
      "process.exit(1);",
    ].join("\n"),
  );
  put("problems.txt", "one\ntwo\n");
  put("server.js", 'require("http").createServer((_, r) => r.end("ok")).listen(8080);\n');
  put(".gitignore", "node_modules\n");
  put("supabase/migrations/001_notes.sql", "create table notes (id int primary key);\n");
  put("config.js", `module.exports = { token: "${leakedKey}" };\n`);
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "First version"], dir);
  // The key is removed, but it stays in the history.
  put("config.js", "module.exports = { token: process.env.TOKEN };\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "Remove the key"], dir);
  git(["tag", "v1"], dir);
  git(["branch", "feature/keep-me"], dir);
}

async function main() {
  if (!gitleaksBin()) throw new Error("Gitleaks is needed: set GITLEAKS_BIN.");

  // ── A new tool ──────────────────────────────────────────────────────────────
  console.log("\nA new tool");
  const fresh = join(work, "fresh-tool");
  const created = script(
    "cli.ts",
    ["new", "--name", "fresh-tool", "--owner", "owner@example.com", "--dir", fresh],
    work,
  );
  expectThat("is created", created.code === 0, created.output);
  const freshChecks = checks(fresh);
  expectThat("passes every check", freshChecks.code === 0, freshChecks.output);
  expectThat("is ready to deploy", freshChecks.ready, freshChecks.output);
  expectThat(
    "has no copy of the platform's agents or report",
    !existsSync(join(fresh, "scripts/sre")) && !existsSync(join(fresh, "ops")),
  );

  // ── An existing tool ────────────────────────────────────────────────────────
  console.log("\nA migrated tool");
  const source = join(work, "original");
  mkdirSync(source);
  // Assembled at run time, so this file holds nothing a secret scanner would flag.
  const key = `ghp_${randomBytes(18).toString("hex")}`;
  makeMessyTool(source, key);
  const before = git(["rev-parse", "HEAD"], source).trim();

  const adopted = join(work, "messy-tool");
  const flags = ["--source", source, "--name", "messy-tool", "--owner", "owner@example.com"];
  const blocked = script("cli.ts", ["migrate", ...flags, "--dir", adopted], work);
  const list = `${adopted}-secrets-to-replace.txt`;
  expectThat("is stopped by a key in its git history", blocked.code === 2, blocked.output);
  expectThat("nothing was moved", !existsSync(adopted));
  expectThat("the list of keys to replace was written", existsSync(list));
  expectThat(
    "the key itself is never printed or saved",
    !blocked.output.includes(key) && !readFileSync(list, "utf8").includes(key),
  );

  const target = join(work, "org-repo.git");
  git(["init", "-q", "--bare", "-b", "main", target], work);
  const moved = script(
    "cli.ts",
    ["migrate", ...flags, "--dir", adopted, "--rotated", list, "--go", "--target", target],
    work,
  );
  expectThat("moves once the key is replaced", moved.code === 0, moved.output);
  const refs = git(["for-each-ref", "--format=%(refname)"], target);
  expectThat(
    "every branch and tag arrived",
    [
      "refs/heads/main",
      "refs/heads/feature/keep-me",
      "refs/heads/platform/adopt",
      "refs/tags/v1",
    ].every((ref) => refs.includes(ref)),
    refs,
  );
  expectThat("the original is unchanged", git(["rev-parse", "HEAD"], source).trim() === before);
  const changed = git(["diff", "--name-only", "main", "platform/adopt"], adopted).split("\n");
  expectThat(
    "application code wasn't touched",
    !["server.js", "lint.cjs", "config.js", "package.json"].some((f) => changed.includes(f)),
    changed.join("\n"),
  );
  const entry = loadRegistry(dataRoot).find((t) => t.name === "messy-tool");
  expectThat(
    "is registered, so the SRE agent and report cover it",
    registrySchema.safeParse(entry).success && entry?.kind === "migrated",
  );

  const baseline = JSON.parse(
    readFileSync(join(adopted, ".platform/baseline.json"), "utf8"),
  ) as Baseline;
  expectThat("records its old lint problems", baseline.checks.lint?.problems === 2);
  expectThat("records missing tests as a to-do", baseline.checks.test?.status === "missing");
  expectThat("marks the open table as serious", baseline.checks.data?.serious === true);

  const first = checks(adopted);
  expectThat("old problems don't block a pull request", first.code === 0, first.output);
  expectThat("but serious issues block deployment", !first.ready, first.output);

  writeFileSync(join(adopted, "problems.txt"), "one\ntwo\nthree\n");
  const worse = checks(adopted);
  expectThat("a new problem fails the pull request", worse.code !== 0, worse.output);
  writeFileSync(join(adopted, "problems.txt"), "one\ntwo\n");

  writeFileSync(
    join(adopted, "supabase/migrations/002_secure.sql"),
    "alter table notes enable row level security;\n",
  );
  const fixed = checks(adopted);
  expectThat("fixing the serious issue clears it to deploy", fixed.ready, fixed.output);

  // ── The SRE agent on a migrated tool ────────────────────────────────────────
  console.log("\nThe SRE agent on a migrated tool");
  const clone = join(work, "sre-clone");
  git(["clone", "--quiet", "--branch", "platform/adopt", target, clone], work);
  const context = {
    repo: "your-org/messy-tool",
    repoDir: clone,
    baseBranch: "platform/adopt",
    incidentId: "INC-SELFTEST",
    tool: "messy-tool",
    author: { name: "SRE agent", email: "sre-agent@example.com" },
    sessionUrl: "https://example.invalid/session",
    outDir: join(work, "sre-output"),
  };
  const proposal = (title: string, path: string, content: string): FixProposal => ({
    kind: "code_fix",
    title,
    summary: "Self-test fix.",
    evidence: "Self-test evidence.",
    confidence: 90,
    files: [{ path, content }],
  });

  const good = await applyFix(
    proposal(
      "Answer with a status",
      "server.js",
      'require("http").createServer((_, r) => r.end("fixed")).listen(8080);\n',
    ),
    context,
  );
  expectThat("a good fix is pushed for a person to review", good.ok, good.problems.join("\n"));
  expectThat(
    "on its own branch, never the main one",
    git(["for-each-ref", "--format=%(refname)", "refs/heads/sre-agent"], target).includes(
      "refs/heads/sre-agent/",
    ),
  );

  const bad = await applyFix(
    proposal("Add a lint problem", "problems.txt", "one\ntwo\nthree\n"),
    context,
  );
  expectThat(
    "a fix that adds a new problem is refused",
    !bad.ok && bad.problems.join(" ").includes("new problem"),
    bad.problems.join("\n"),
  );

  // Code the agent writes runs in the checks, so it must not be able to read a credential.
  const dump = join(work, "env-dump.json");
  process.env.ANTHROPIC_API_KEY = "selftest-sentinel";
  await applyFix(
    proposal(
      "Try to read the credentials",
      "lint.cjs",
      `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\nconsole.log("✖ 2 problems");\nprocess.exit(1);\n`,
    ),
    context,
  );
  delete process.env.ANTHROPIC_API_KEY;
  expectThat("the agent's code ran during the check", existsSync(dump));
  expectThat(
    "and it couldn't see the pipeline's credentials",
    existsSync(dump) && !readFileSync(dump, "utf8").includes("selftest-sentinel"),
  );

  rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} checks failed.` : "\nEvery self-test passed.");
  if (failures) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
