// Runs code nobody has reviewed yet, such as an AI agent's proposed fix, away from the pipeline.
// Removing credentials from a child's environment isn't enough on a shared machine: it can still
// read its parent's environment from /proc, the Azure login cache and the git directory. So the
// code runs in a locked-down container that holds a plain copy of the commit and nothing else.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { safeEnv } from "./env.js";
import type { Manifest } from "./model.js";

const COMMAND_TIMEOUT = 10 * 60_000;
const OUTPUT_LIMIT = 512 * 1024;
const PATH = "/cache/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface Sandbox {
  /** A throwaway copy of the code, with no git history. Mounted at /work. */
  dir: string;
  /** Throwaway package caches, so the offline steps can use what install fetched. */
  cache: string;
  image: string;
}

export interface SandboxResult {
  ok: boolean;
  output: string;
  crashed: boolean;
}

const dockerBin = () => process.env.PLATFORM_DOCKER_BIN || "docker";

export function dockerAvailable(): boolean {
  try {
    execFileSync(dockerBin(), ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const sandboxImage = (manifest: Pick<Manifest, "packageManager" | "nodeVersion">) =>
  manifest.packageManager === "bun" ? "oven/bun:1-slim" : `node:${manifest.nodeVersion}-slim`;

/** pnpm and Yarn come through Corepack, which needs somewhere writable for its commands. */
export const installCommand = (manifest: Pick<Manifest, "packageManager">, install: string) =>
  manifest.packageManager === "pnpm" || manifest.packageManager === "yarn"
    ? `mkdir -p /cache/bin && corepack enable --install-directory /cache/bin && ${install}`
    : install;

const hostUser = () =>
  process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : "1000:1000";

/** Every setting is explicit. Nothing from this machine's environment is passed in. */
export function sandboxArgs(
  box: Sandbox,
  command: string,
  options: { network?: boolean; name?: string; user?: string } = {},
): string[] {
  return [
    "run",
    "--rm",
    "--init",
    ...(options.name ? ["--name", options.name] : []),
    "--network",
    options.network ? "bridge" : "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "1024",
    "--memory",
    "4g",
    "--user",
    options.user ?? hostUser(),
    "--mount",
    `type=bind,src=${resolve(box.dir)},dst=/work`,
    "--mount",
    `type=bind,src=${resolve(box.cache)},dst=/cache`,
    "--workdir",
    "/work",
    "--env",
    "HOME=/cache/home",
    "--env",
    `PATH=${PATH}`,
    "--env",
    "COREPACK_HOME=/cache/corepack",
    "--env",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "--env",
    "npm_config_cache=/cache/npm",
    "--env",
    "CI=true",
    "--env",
    "NO_COLOR=1",
    "--env",
    "FORCE_COLOR=0",
    box.image,
    "sh",
    "-c",
    command,
  ];
}

/** A plain copy of a commit: no .git, and export rules in the repository can't drop files. */
export function exportCommit(repoDir: string, commit: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "platform-export-"));
  const env = { ...safeEnv(), GIT_INDEX_FILE: join(work, "index") };
  try {
    execFileSync("git", ["read-tree", commit], { cwd: repoDir, env, stdio: "ignore" });
    execFileSync(
      "git",
      ["checkout-index", "--all", "--force", `--prefix=${resolve(dest).split("\\").join("/")}/`],
      { cwd: repoDir, env, stdio: "ignore" },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function createSandbox(root: string, manifest: Manifest, name = "code"): Sandbox {
  const dir = join(root, name);
  const cache = join(root, "cache");
  mkdirSync(dir, { recursive: true });
  for (const folder of ["home", "corepack", "npm", "bin"]) {
    mkdirSync(join(cache, folder), { recursive: true });
  }
  return { dir, cache, image: sandboxImage(manifest) };
}

export function runInSandbox(
  box: Sandbox,
  command: string,
  options: { network?: boolean } = {},
): Promise<SandboxResult> {
  const name = `platform-check-${randomUUID()}`;
  const env = safeEnv();
  return new Promise((done) => {
    const child = spawn(dockerBin(), sandboxArgs(box, command, { ...options, name }), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      // Killing the client would leave the container running.
      try {
        execFileSync(dockerBin(), ["rm", "--force", name], { env, stdio: "ignore" });
      } catch {
        child.kill("SIGKILL");
      }
    }, COMMAND_TIMEOUT);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, output: `${output}\n${error.message}`, crashed: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // 125 is Docker itself failing. 126 and up: couldn't run, not found, or killed.
      const crashed = code !== 0 && (signal !== null || code === null || code >= 125);
      done({ ok: code === 0, output, crashed });
    });
  });
}
