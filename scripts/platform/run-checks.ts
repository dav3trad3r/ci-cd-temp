// Runs a tool's checks: its own install, lint, test and build commands, then the platform's
// secret, exposed-data and vulnerability checks. Used by CI, by `tool migrate` to write the first
// baseline, and by the SRE agent to test a fix. A tool's commands never see pipeline credentials.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CHECK_LABELS,
  CHECK_ORDER,
  type Baseline,
  type CheckName,
  type Evaluated,
  type RawResult,
} from "./baseline.js";
import { safeEnv } from "./env.js";
import { findUnprotectedTables, usesSupabase, type SqlFile } from "./exposure.js";
import { BASELINE_PATH, PLATFORM_ROOT, type Manifest } from "./model.js";
import { gitleaksBin, leakLine, scanHistory } from "./secrets.js";

const COMMAND_TIMEOUT = 10 * 60_000;
const OUTPUT_LIMIT = 512 * 1024;

interface Ran {
  ok: boolean;
  output: string;
}

function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, shell: boolean) {
  return new Promise<Ran>((done) => {
    const child = spawn(file, args, { cwd, env, shell, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, output });
    });
  });
}

export function loadBaseline(dir: string): Baseline | undefined {
  const path = join(dir, BASELINE_PATH);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Baseline) : undefined;
}

function sqlFiles(dir: string): SqlFile[] {
  const roots = ["db", "supabase/migrations", "migrations", "prisma/migrations", "sql"];
  const out: SqlFile[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (entry.name.endsWith(".sql") && statSync(path).size < 2_000_000) {
        out.push({
          path: relative(dir, path).split("\\").join("/"),
          text: readFileSync(path, "utf8"),
        });
      }
    }
  };
  for (const root of roots) {
    const path = join(dir, root);
    if (existsSync(path)) walk(path);
  }
  return out;
}

function dataCheck(dir: string): RawResult {
  const packagePath = join(dir, "package.json");
  const pkg = existsSync(packagePath)
    ? (JSON.parse(readFileSync(packagePath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      })
    : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!usesSupabase(deps, readdirSync(dir))) {
    return { name: "data", configured: true, ok: true, output: "", skipped: "no Supabase" };
  }
  const problems = findUnprotectedTables(sqlFiles(dir));
  return { name: "data", configured: true, ok: problems.length === 0, output: problems.join("\n") };
}

async function auditCheck(dir: string, manifest: Manifest, env: NodeJS.ProcessEnv) {
  const name = "audit" as const;
  const commands: Partial<Record<NonNullable<Manifest["packageManager"]>, [string, string]>> = {
    npm: ["npm audit --omit=dev --audit-level=high", "package-lock.json"],
    pnpm: ["pnpm audit --prod --audit-level high", "pnpm-lock.yaml"],
  };
  const entry = manifest.packageManager ? commands[manifest.packageManager] : undefined;
  if (!entry || !existsSync(join(dir, entry[1]))) {
    return { name, configured: true, ok: true, output: "", skipped: "no lockfile to audit" };
  }
  const result = await run(entry[0], [], dir, env, true);
  if (!result.ok && /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|audit endpoint/i.test(result.output))
    return { name, configured: true, ok: true, output: "", skipped: "audit service unreachable" };
  return { name, configured: true, ok: result.ok, output: result.output };
}

function secretCheck(dir: string): RawResult {
  const name = "secrets";
  if (!existsSync(join(dir, ".git"))) {
    return { name, configured: true, ok: true, output: "", skipped: "not a git repository" };
  }
  const bin = gitleaksBin();
  if (!bin) {
    return process.env.CI
      ? { name, configured: true, ok: false, output: "✗ Gitleaks is not installed." }
      : { name, configured: true, ok: true, output: "", skipped: "Gitleaks not installed" };
  }
  const ignore = join(dir, ".gitleaksignore");
  const leaks = scanHistory(dir, bin, existsSync(ignore) ? ignore : undefined);
  return { name, configured: true, ok: leaks.length === 0, output: leaks.map(leakLine).join("\n") };
}

export interface CheckOptions {
  dir: string;
  manifest: Manifest;
  /** Run only these checks. */
  only?: CheckName[];
  /** Skip the install step, for a folder that already has its dependencies. */
  installed?: boolean;
  onResult?: (result: RawResult) => void;
}

export async function collectResults(options: CheckOptions): Promise<RawResult[]> {
  const { dir, manifest, only, installed, onResult } = options;
  const env = safeEnv();
  const results: RawResult[] = [];
  const wanted = (name: CheckName) => !only || only.includes(name);
  const add = (result: RawResult) => {
    results.push(result);
    onResult?.(result);
  };
  const skip = (name: CheckName, reason: string) =>
    add({ name, configured: true, ok: true, output: "", skipped: reason });

  const command = async (name: Exclude<keyof Manifest["commands"], never> & CheckName) => {
    const text = manifest.commands[name];
    if (!text) {
      add({ name, configured: false, ok: false, output: "" });
      return false;
    }
    const result = await run(text, [], dir, env, true);
    add({ name, configured: true, ok: result.ok, output: result.output });
    return result.ok;
  };

  let canRun = true;
  if (installed) {
    if (wanted("install")) skip("install", "already installed");
  } else if (manifest.commands.install) {
    canRun = await command("install");
  } else if (wanted("install")) {
    add({ name: "install", configured: false, ok: false, output: "" });
    canRun = false;
  }

  if (wanted("secrets")) add(secretCheck(dir));

  let built = false;
  for (const name of ["format", "lint", "typecheck", "test", "build"] as const) {
    if (!wanted(name)) continue;
    if (!canRun && manifest.commands[name]) skip(name, "install failed");
    else {
      const ok = await command(name);
      if (name === "build") built = ok;
    }
  }

  if (wanted("frontend")) {
    const webDir = manifest.webDir;
    if (!webDir) skip("frontend", "no browser files");
    else if (!existsSync(join(dir, webDir)))
      skip("frontend", built ? `${webDir} wasn't produced` : "no build to check");
    else {
      const result = await run(
        process.execPath,
        [join(PLATFORM_ROOT, "scripts/check-frontend.mjs")],
        dir,
        { ...env, FRONTEND_WEB_DIR: webDir },
        false,
      );
      add({ name: "frontend", configured: true, ok: result.ok, output: result.output });
    }
  }

  if (wanted("data")) add(dataCheck(dir));
  if (wanted("audit")) add(await auditCheck(dir, manifest, env));

  if (wanted("smoke")) {
    if (manifest.commands.smoke && (!canRun || (manifest.commands.build && !built)))
      skip("smoke", "no build to test");
    else await command("smoke");
  }

  if (wanted("eval")) {
    const nightly = process.env.GITHUB_EVENT_NAME === "schedule" || process.env.PLATFORM_RUN_EVAL;
    if (manifest.commands.eval && !nightly) skip("eval", "runs nightly");
    else if (manifest.commands.eval && !canRun) skip("eval", "install failed");
    else await command("eval");
  }

  return results.sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name));
}

const STATUS_WORD: Record<Evaluated["status"], string> = {
  pass: "Passed",
  known: "Known issue",
  todo: "To do",
  skip: "Not applicable",
  fail: "FAILED",
};

export function summaryTable(results: Evaluated[]): string {
  const rows = results.map((r) => {
    const status =
      r.serious && r.status === "known" ? "Must fix before go-live" : STATUS_WORD[r.status];
    return `| ${CHECK_LABELS[r.name]} | ${status} | ${r.detail} |`;
  });
  return ["| Check | Result | Detail |", "| --- | --- | --- |", ...rows].join("\n");
}
