// Works out how an existing tool installs, tests, builds and starts, from the files it already
// has. Staff-built tools vary, so nothing here assumes this template's own layout. Pure, so every
// rule is unit-tested; a check it can't find becomes a to-do on the tool's baseline.
import type { Commands, Manifest } from "./model.js";

export interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  main?: string;
}

export interface RepoFacts {
  /** Paths at the top of the repository. */
  files: string[];
  packageJson?: PackageJson;
  /** The contents of vite.config.*, if any. */
  viteConfig?: string;
  /** The contents of the tool's own Dockerfile, if any. */
  dockerfile?: string;
  nodeVersionFile?: string;
  /** The contents of the tool's server code, read to spot migrations at startup. */
  sourceFiles?: string[];
}

export type Detected = Pick<
  Manifest,
  | "stack"
  | "nodeVersion"
  | "packageManager"
  | "commands"
  | "webDir"
  | "start"
  | "migrate"
  | "migratesAtStartup"
  | "port"
  | "healthPath"
  | "dockerfile"
>;

type PackageManager = NonNullable<Manifest["packageManager"]>;

const NO_COMMANDS: Commands = {
  install: null,
  format: null,
  lint: null,
  typecheck: null,
  test: null,
  build: null,
  smoke: null,
  eval: null,
};

export const GENERATED_DOCKERFILE = ".platform/Dockerfile";

function packageManager(files: string[]): PackageManager {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  return "npm";
}

function installCommand(pm: PackageManager, files: string[]): string {
  if (pm === "pnpm") return "pnpm install --frozen-lockfile";
  if (pm === "yarn") return "yarn install --frozen-lockfile";
  if (pm === "bun") return "bun install --frozen-lockfile";
  return files.includes("package-lock.json")
    ? "npm ci --no-audit --no-fund"
    : "npm install --no-audit --no-fund";
}

const runner = (pm: PackageManager, script: string) =>
  pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`;

const exec = (pm: PackageManager, command: string) =>
  pm === "npm"
    ? `npx --no-install ${command}`
    : pm === "pnpm"
      ? `pnpm exec ${command}`
      : pm === "yarn"
        ? `yarn ${command}`
        : `bunx ${command}`;

function firstScript(scripts: Record<string, string>, names: string[]): string | undefined {
  return names.find((name) => scripts[name] !== undefined);
}

/** `npm init` writes a test script that only fails. That isn't a test suite. */
function realTestScript(scripts: Record<string, string>): string | undefined {
  const name = firstScript(scripts, ["test", "test:unit", "test:ci"]);
  if (!name) return undefined;
  return /no test specified/i.test(scripts[name] ?? "") ? undefined : name;
}

function webDir(facts: RepoFacts, deps: Record<string, string>): string | null {
  if (deps.next) return ".next/static";
  if (deps.nuxt) return ".output/public";
  if (deps["@sveltejs/kit"]) return ".svelte-kit/output/client";
  if (deps["react-scripts"]) return "build";
  if (deps["@remix-run/dev"] || deps["@react-router/dev"]) return "build/client";
  if (deps.astro) return "dist";
  if (deps.vite) {
    const outDir = facts.viteConfig?.match(/outDir\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    return outDir ? outDir.replace(/^(\.\.?\/)+/, "") : "dist";
  }
  return null;
}

function startCommand(facts: RepoFacts, pm: PackageManager): string | null {
  const scripts = facts.packageJson?.scripts ?? {};
  if (scripts.start) return runner(pm, "start");
  if (facts.packageJson?.main && !facts.packageJson.main.startsWith("dist/types")) {
    return `node ${facts.packageJson.main}`;
  }
  const entry = ["server.js", "server.mjs", "index.js", "app.js"].find((f) =>
    facts.files.includes(f),
  );
  return entry ? `node ${entry}` : null;
}

function portOf(facts: RepoFacts): number {
  const exposed = facts.dockerfile?.match(/^\s*EXPOSE\s+(\d+)/im)?.[1];
  return exposed ? Number(exposed) : 8080;
}

/** The major version from engines or .node-version. Anything below 20 is out of support. */
function nodeVersion(facts: RepoFacts): string {
  const wanted = facts.nodeVersionFile ?? facts.packageJson?.engines?.node ?? "";
  const major = Number(wanted.match(/\d+/)?.[0]);
  return Number.isFinite(major) && major >= 20 ? String(major) : "22";
}

const MIGRATION_COMMAND = /migrat|prisma\s+db\s+push|drizzle-kit\s+push|supabase\s+db\s+push/i;
const MIGRATION_CODE =
  /\bapplyMigrations\s*\(|\brunMigrations\s*\(|\.migrate\.latest\s*\(|\bsynchronize\s*:\s*true\b|\bsequelize\.sync\s*\(|drizzle-orm\/[\w-]+\/migrator|from\s+["']umzug["']/;

/** A staging revision shares the production database, so migrating at boot skips the approval. */
export function migratesAtStartup(facts: RepoFacts): boolean {
  const scripts = facts.packageJson?.scripts ?? {};
  const docker = (facts.dockerfile ?? "")
    .split("\n")
    .filter((line) => /^\s*(CMD|ENTRYPOINT)\b/i.test(line));
  const startup = [scripts.prestart, scripts.start, scripts.poststart, ...docker];
  return (
    startup.some((text) => text !== undefined && MIGRATION_COMMAND.test(text)) ||
    (facts.sourceFiles ?? []).some((text) => MIGRATION_CODE.test(text))
  );
}

export function detectStack(facts: RepoFacts): Detected {
  if (!facts.packageJson) {
    return {
      stack: "unknown",
      nodeVersion: "22",
      packageManager: null,
      commands: { ...NO_COMMANDS },
      webDir: null,
      start: null,
      // Never guessed: a script called "migrate" could be a development reset.
      migrate: null,
      migratesAtStartup: migratesAtStartup(facts),
      port: portOf(facts),
      healthPath: "/",
      dockerfile: facts.dockerfile ? "Dockerfile" : null,
    };
  }

  const scripts = facts.packageJson.scripts ?? {};
  const deps = { ...facts.packageJson.dependencies, ...facts.packageJson.devDependencies };
  const pm = packageManager(facts.files);
  const script = (names: string[]) => {
    const name = firstScript(scripts, names);
    return name ? runner(pm, name) : null;
  };

  const typecheck =
    script(["typecheck", "type-check", "check-types", "tsc"]) ??
    (facts.files.includes("tsconfig.json") && deps.typescript ? exec(pm, "tsc --noEmit") : null);
  const test = realTestScript(scripts);
  const web = webDir(facts, deps);
  const start = startCommand(facts, pm);

  return {
    stack: "node",
    nodeVersion: nodeVersion(facts),
    packageManager: pm,
    commands: {
      install: installCommand(pm, facts.files),
      format: script(["format:check", "fmt:check", "prettier:check", "check:format"]),
      lint: script(["lint"]),
      typecheck,
      test: test ? runner(pm, test) : null,
      build: script(["build"]),
      smoke: script(["smoke"]),
      eval: script(["eval", "evals", "test:eval"]),
    },
    webDir: web,
    start,
    migrate: null,
    migratesAtStartup: migratesAtStartup(facts),
    port: portOf(facts),
    healthPath: "/",
    dockerfile: facts.dockerfile ? "Dockerfile" : start || web ? GENERATED_DOCKERFILE : null,
  };
}
