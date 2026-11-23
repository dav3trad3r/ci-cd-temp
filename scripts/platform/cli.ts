// The two ways onto the platform, and the upkeep around them.
//   npm run tool -- setup   --org <org> [--team pipeline-approvers] [--repo ci-cd-temp]
//   npm run tool -- new     --name <tool> --owner <email> [--dir ../<tool>]
//   npm run tool -- migrate --source <path or git URL> --name <tool> --owner <email> [--go]
//   npm run tool -- update  --path ../<tool>
//   npm run tool -- list
// Both `new` and `migrate` end in the same place: a repository with the platform's checks, deploy
// pipeline and agent rules, registered so the SRE agent and the afternoon report cover it.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CHECK_LABELS, evaluate, makeBaseline, SERIOUS } from "./baseline.js";
import { detectStack, type PackageJson, type RepoFacts } from "./detect.js";
import {
  BASELINE_PATH,
  DATA_ROOT,
  loadManifest,
  loadRegistry,
  loadSettings,
  MANIFEST_PATH,
  manifestSchema,
  newRegistryEntry,
  PLATFORM_ROOT,
  platformVersion,
  saveManifest,
  saveRegistryEntry,
  saveSettings,
  type Manifest,
  type RegistryEntry,
} from "./model.js";
import { collectResults, summaryTable } from "./run-checks.js";
import { gitleaksBin, leakLine, scanHistory } from "./secrets.js";
import { applyToolFiles, bicepParamFile } from "./tool-files.js";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);
function need(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`Give --${name}.`);
  return value;
}

const IDENTITY = [
  "-c",
  "user.name=Platform",
  "-c",
  "user.email=platform@users.noreply.github.com",
  "-c",
  "core.autocrlf=false",
];

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
  });
}

/** A git URL with any embedded username or token removed, safe to print and to record. */
export function safeSource(source: string): string {
  return source.replace(/^(https?:\/\/)[^/@]+@/i, "$1");
}

function readFacts(dir: string): RepoFacts {
  const files = readdirSync(dir);
  const text = (name: string) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined;
  const vite = files.find((f) => /^vite\.config\.[cm]?[jt]s$/.test(f));
  const packageText = text("package.json");
  return {
    files,
    packageJson: packageText ? (JSON.parse(packageText) as PackageJson) : undefined,
    viteConfig: vite ? text(vite) : undefined,
    dockerfile: text("Dockerfile"),
    nodeVersionFile: text(".node-version") ?? text(".nvmrc"),
  };
}

function registerTool(entry: RegistryEntry, manifest: Manifest) {
  const settings = loadSettings();
  saveRegistryEntry(entry);
  const params = join(DATA_ROOT, entry.parameters);
  mkdirSync(dirname(params), { recursive: true });
  if (!existsSync(params)) writeFileSync(params, bicepParamFile(entry, manifest, settings));
}

const classification = () => {
  const value = flag("data") ?? "Internal";
  if (!["Public", "Internal", "Confidential", "Restricted"].includes(value)) {
    throw new Error("--data must be Public, Internal, Confidential or Restricted.");
  }
  return value as RegistryEntry["dataClassification"];
};

const budget = () => {
  const value = flag("budget");
  return value ? Number(value) : undefined;
};

function assertNew(name: string, dir: string) {
  if (loadRegistry().some((t) => t.name === name)) {
    throw new Error(`${name} is already registered in ops/tools/.`);
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and isn't empty.`);
  }
}

// ── setup ───────────────────────────────────────────────────────────────────────

function setup() {
  const settings = loadSettings();
  settings.org = need("org");
  settings.approversTeam = flag("team") ?? settings.approversTeam;
  settings.platformRepo = flag("repo") ?? settings.platformRepo;
  saveSettings(settings);
  const owner = `@${settings.org}/${settings.approversTeam}`;
  writeFileSync(
    join(PLATFORM_ROOT, ".github/CODEOWNERS"),
    [
      "# Who reviews what. The Pipeline approvers review every pull request.",
      `*                    ${owner}`,
      `/.github/            ${owner}`,
      `/db/migrations/      ${owner}`,
      "",
    ].join("\n"),
  );
  console.log(
    `Platform set to ${settings.org}/${settings.platformRepo}, approvers ${owner}. Commit ops/platform.json and .github/CODEOWNERS.`,
  );
}

// ── new ─────────────────────────────────────────────────────────────────────────

/** The working example a new tool starts from: the app and its tests, not the platform. */
const STARTER_PATHS = [
  "src",
  "db",
  "evals",
  "tests/helpers.ts",
  "tests/security",
  "tests/regressions/README.md",
  "tests/regressions/__snapshots__",
  "tests/regressions/api-contract.test.ts",
  "tests/regressions/2026-11-11-due-time-zone.test.ts",
  "tests/unit/validation.test.ts",
  "scripts/smoke.mjs",
  "budgets.json",
  "vite.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.js",
  ".prettierrc.json",
  ".prettierignore",
  ".gitattributes",
  ".gitignore",
  ".node-version",
  "SECURITY.md",
];

const STARTER_SCRIPTS = [
  "dev",
  "build",
  "start",
  "typecheck",
  "lint",
  "format",
  "format:check",
  "test",
  "smoke",
  "eval",
];

function starterPackage(name: string, owner: string) {
  const source = JSON.parse(readFileSync(join(PLATFORM_ROOT, "package.json"), "utf8")) as {
    type: string;
    engines: Record<string, string>;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  return {
    name,
    version: "0.1.0",
    private: true,
    description: `${name}, owned by ${owner}.`,
    type: source.type,
    engines: source.engines,
    scripts: Object.fromEntries(STARTER_SCRIPTS.map((s) => [s, source.scripts[s] as string])),
    dependencies: source.dependencies,
    devDependencies: Object.fromEntries(
      Object.entries(source.devDependencies).filter(([d]) => !d.startsWith("@anthropic-ai/")),
    ),
  };
}

function createNew() {
  const settings = loadSettings();
  const name = need("name");
  const owner = need("owner");
  const dir = resolve(flag("dir") ?? join(PLATFORM_ROOT, "..", name));
  const manifest = manifestSchema.parse({
    name,
    kind: "new",
    owner,
    stack: "node",
    nodeVersion: "22",
    packageManager: "npm",
    commands: {
      install: "npm ci --no-audit --no-fund",
      format: "npm run format:check",
      lint: "npm run lint",
      typecheck: "npm run typecheck",
      test: "npm test",
      build: "npm run build",
      smoke: "npm run smoke",
      eval: "npm run eval",
    },
    webDir: "dist/web",
    start: "npm start",
    port: 8080,
    healthPath: "/healthz",
    dockerfile: ".platform/Dockerfile",
  });
  assertNew(name, dir);
  const entry = newRegistryEntry({
    name,
    kind: "new",
    owner,
    org: settings.org,
    dataClassification: classification(),
    dailyBudget: budget(),
  });

  mkdirSync(dir, { recursive: true });
  for (const path of STARTER_PATHS) {
    const from = join(PLATFORM_ROOT, path);
    if (existsSync(from)) cpSync(from, join(dir, path), { recursive: true });
  }
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(starterPackage(name, owner), null, 2)}\n`,
  );
  cpSync(join(PLATFORM_ROOT, "package-lock.json"), join(dir, "package-lock.json"));
  execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  writeFileSync(
    join(dir, ".env.example"),
    [
      "# Copy to .env for local settings. Never commit .env.",
      "",
      "# Server-only settings. Never prefix these with VITE_.",
      "APP_JWT_SECRET=replace-with-a-long-random-value",
      "DATABASE_URL=postgres://app:password@localhost:5432/app",
      "BUSINESS_TIME_ZONE=Australia/Brisbane",
      "",
      "# Browser settings. Anything starting VITE_ is readable by every visitor.",
      `VITE_APP_NAME=${name}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "README.md"),
    [
      `# ${name}`,
      "",
      `Owner: ${owner}. Built on the ${settings.org}/${settings.platformRepo} platform.`,
      "",
      "```bash",
      "npm ci",
      "npm run dev",
      "```",
      "",
      "Work on a branch and open a pull request. The **Platform** workflow runs the checks, and a Pipeline approver reviews and merges. Merging builds the tool, deploys it to staging, and waits for approval before production.",
      "",
      "`.platform/tool.json` says how this tool installs, tests and builds. `AGENTS.md` holds the rules for AI coding agents.",
      "",
    ].join("\n"),
  );
  saveManifest(dir, manifest);
  const applied = applyToolFiles(dir, manifest, settings, platformVersion(), entry.baseBranch);
  git(["init", "-q", "-b", entry.baseBranch], dir);
  git(["add", "-A"], dir);
  git([...IDENTITY, "commit", "-q", "-m", `Start ${name} on the platform`], dir);
  registerTool(entry, manifest);

  console.log(`Created ${name} in ${dir}.`);
  applied.notes.forEach((n) => console.log(`Note: ${n}`));
  console.log(
    [
      "",
      "Next:",
      `1. Create the private repository ${entry.repo} and push this folder to it.`,
      `2. Commit ops/tools/${name}.json and ${entry.parameters} in the platform repository.`,
      `3. Deploy the Azure resources when the tool is ready (README, "Connect a tool to Azure").`,
    ].join("\n"),
  );
}

// ── migrate ─────────────────────────────────────────────────────────────────────

async function github(method: string, path: string, token: string, body?: unknown) {
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ci-cd-temp-platform",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    message?: string;
    html_url?: string;
  };
  if (!response.ok) {
    throw new Error(`${method} ${path}: GitHub answered ${response.status} ${data.message ?? ""}`);
  }
  return data;
}

/** Passes the token to git through its environment, so it's never in a URL, argument or file. */
function gitAuth(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

async function migrate() {
  const settings = loadSettings();
  const source = need("source");
  const name = need("name");
  const owner = need("owner");
  const dir = resolve(flag("dir") ?? join(PLATFORM_ROOT, "..", `${name}-migrated`));
  const go = has("go");
  manifestSchema.shape.name.parse(name);
  manifestSchema.shape.owner.parse(owner);
  assertNew(name, dir);

  const bin = gitleaksBin();
  if (!bin) throw new Error("Gitleaks is needed to scan the history. Set GITLEAKS_BIN.");

  const work = mkdtempSync(join(tmpdir(), `migrate-${name}-`));
  const mirror = join(work, "mirror.git");
  try {
    // 1. An exact copy of every branch and tag. The original repository isn't changed.
    console.log(`1. Copying ${safeSource(source)}`);
    git(["clone", "--quiet", "--mirror", source, mirror], work);
    const baseBranch = flag("branch") ?? git(["symbolic-ref", "--short", "HEAD"], mirror).trim();
    const commits = git(["rev-list", "--all", "--count"], mirror).trim();

    // 2. Nothing moves until every secret in the history has been replaced.
    console.log(`2. Scanning ${commits} commits for secrets`);
    const replaced = flag("rotated") ? resolve(need("rotated")) : undefined;
    if (replaced) {
      const lines = readFileSync(replaced, "utf8");
      if (!lines.trim()) throw new Error(`${replaced} is empty.`);
    }
    const leaks = scanHistory(mirror, bin, replaced);
    if (leaks.length) {
      const file = `${dir}-secrets-to-replace.txt`;
      writeFileSync(
        file,
        [
          `# ${name}: replace each of these keys at its provider, then delete any line you haven't replaced.`,
          "# Run the migration again with --rotated and this file. The keys themselves aren't listed.",
          ...leaks.flatMap((l) => [`# ${leakLine(l).slice(2)}`, l.fingerprint]),
          "",
        ].join("\n"),
      );
      console.error(leaks.map(leakLine).join("\n"));
      console.error(
        `\nStopped: ${leaks.length} secret${leaks.length === 1 ? "" : "s"} in the history, and nothing was moved.\nReplace them, then run this again with --rotated "${file}".`,
      );
      process.exitCode = 2;
      return;
    }
    console.log("   No unreplaced secrets found.");

    // 3. Work out how the tool builds, without changing its code.
    git(["clone", "--quiet", "--branch", baseBranch, mirror, dir], work);
    git(["checkout", "-q", "-b", "platform/adopt"], dir);
    const detected = detectStack(readFacts(dir));
    const manifest = manifestSchema.parse({ name, kind: "migrated", owner, ...detected });
    console.log(
      `3. Detected ${manifest.stack === "node" ? `${manifest.packageManager} on Node ${manifest.nodeVersion}` : "an unsupported stack, so it gets secret scanning and guardrails first"}`,
    );

    // 4. Add the platform's files.
    saveManifest(dir, manifest);
    const applied = applyToolFiles(dir, manifest, settings, platformVersion(), baseBranch);
    if (replaced) {
      const fingerprints = readFileSync(replaced, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"));
      writeFileSync(join(dir, ".gitleaksignore"), `${fingerprints.join("\n")}\n`);
    }

    // 5. Write down what already fails, so old problems don't block new work.
    console.log("4. Running every check to record the baseline");
    const raw = await collectResults({
      dir,
      manifest,
      onResult: (r) =>
        console.log(
          `   ${CHECK_LABELS[r.name]}: ${r.skipped ?? (r.configured ? (r.ok ? "passed" : "failing") : "not set up")}`,
        ),
    });
    const baseline = makeBaseline(raw, new Date().toISOString().slice(0, 10));
    writeFileSync(join(dir, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
    const results = raw.map((r) => evaluate(r, baseline));
    const serious = results.filter((r) => SERIOUS.has(r.name) && r.status === "known");

    const paths = [
      MANIFEST_PATH,
      BASELINE_PATH,
      ...applied.written,
      ...(replaced ? [".gitleaksignore"] : []),
    ];
    git(["add", "--", ...new Set(paths)], dir);
    git(
      [
        ...IDENTITY,
        "commit",
        "-q",
        "-m",
        "Adopt the platform",
        "-m",
        "Adds the checks, deploy pipeline, code owners and agent rules. Application code is unchanged.",
      ],
      dir,
    );

    const entry = newRegistryEntry({
      name,
      kind: "migrated",
      owner,
      org: settings.org,
      baseBranch,
      dataClassification: classification(),
      dailyBudget: budget(),
      source: safeSource(source),
    });
    registerTool(entry, manifest);

    console.log(`\n${summaryTable(results)}\n`);
    applied.notes.forEach((n) => console.log(`Note: ${n}`));
    if (serious.length) {
      console.log(
        `${serious.length} serious issue${serious.length === 1 ? "" : "s"} must be fixed before this tool can deploy.`,
      );
    }

    // 6. Move it: a private organisation repository, with the platform as a pull request.
    const target = flag("target") ?? `https://github.com/${entry.repo}.git`;
    if (!go) {
      console.log(
        [
          "",
          `Dry run: nothing has been pushed. The adopted copy is in ${dir}.`,
          "To move it, run the same command with --go (needs GITHUB_ADMIN_TOKEN).",
        ].join("\n"),
      );
      return;
    }

    const token = process.env.GITHUB_ADMIN_TOKEN;
    const external = !flag("target");
    if (external && !token) throw new Error("Set GITHUB_ADMIN_TOKEN to create the repository.");
    if (external && token) {
      await github("POST", `/orgs/${settings.org}/repos`, token, {
        name,
        visibility: "private",
        has_wiki: false,
      });
    }
    const env = external && token ? gitAuth(token) : process.env;
    git(["push", "--quiet", target, "--all"], mirror, env);
    git(["push", "--quiet", target, "--tags"], mirror, env);
    git(["push", "--quiet", target, "platform/adopt"], dir, env);
    console.log(`Moved every branch and tag to ${target}.`);

    if (external && token) {
      const pr = await github("POST", `/repos/${entry.repo}/pulls`, token, {
        title: "Adopt the platform",
        head: "platform/adopt",
        base: baseBranch,
        body: [
          `Moves ${name} onto the platform. Application code is unchanged.`,
          "",
          summaryTable(results),
          "",
          "A Pipeline approver reviews this and adds the `guardrail-change` label, because it adds the files that decide what gets checked.",
        ].join("\n"),
      });
      console.log(`Pull request: ${pr.html_url}`);
    }
    console.log(
      [
        "",
        "Next:",
        `1. Merge the pull request once a Pipeline approver has reviewed it.`,
        `2. Commit ops/tools/${name}.json and ${entry.parameters} in the platform repository.`,
        "3. Archive the original private repository, so there's only one copy to work in.",
      ].join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── update / list ───────────────────────────────────────────────────────────────

function update() {
  const dir = resolve(need("path"));
  const manifest = loadManifest(dir);
  const entry = loadRegistry().find((t) => t.name === manifest.name);
  const applied = applyToolFiles(
    dir,
    manifest,
    loadSettings(),
    platformVersion(),
    entry?.baseBranch ?? "main",
  );
  console.log(
    applied.written.length
      ? `Updated: ${applied.written.join(", ")}. Review them and open a pull request.`
      : `${manifest.name} is already on the current platform files.`,
  );
  applied.notes.forEach((n) => console.log(`Note: ${n}`));
}

function list() {
  const tools = loadRegistry();
  if (!tools.length) {
    console.log("No tools registered yet.");
    return;
  }
  for (const t of tools) {
    console.log(`${t.name} (${t.kind})  owner ${t.owner}  repo ${t.repo}`);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────────

try {
  if (command === "setup") setup();
  else if (command === "new") createNew();
  else if (command === "migrate") await migrate();
  else if (command === "update") update();
  else if (command === "list") list();
  else console.log("Commands: setup, new, migrate, update, list. See the README.");
} catch (error) {
  const stderr = (error as { stderr?: unknown }).stderr;
  const message = typeof stderr === "string" && stderr.trim() ? stderr : (error as Error).message;
  console.error(String(message).trim().split("\n").slice(-4).join("\n"));
  process.exit(1);
}
