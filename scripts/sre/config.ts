// Shared pieces for the SRE agent: its settings (ops/sre-agent.json), the IDs that setup
// created (ops/sre-agent.lock.json), the Anthropic client, and small git and Azure CLI helpers.
import Anthropic from "@anthropic-ai/sdk";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadRegistry, type RegistryEntry } from "../platform/model.js";

export interface SreTool {
  name: string;
  owner: string;
  /** GitHub username asked to review the agent's pull requests, if any. */
  githubReviewer?: string;
  repo: string;
  baseBranch: string;
  resourceGroup: string;
  containerApp: string;
  /** Log Analytics workspace (customer) ID, for get_logs on Azure. */
  logAnalyticsWorkspaceId?: string;
}

export interface SreConfig {
  model: string;
  /** Hard spend cap per incident session, in US dollars (Managed Agents session budget). */
  budgetUsd: number;
  timeoutMinutes: number;
  commitAuthor: { name: string; email: string };
  tools: SreTool[];
}

/** IDs of what setup created. Not secret: they're useless without the API key. */
export interface SreLock {
  environmentId?: string;
  skillId?: string;
  skillHash?: string;
  teamMemoryId?: string;
  notebookMemoryId?: string;
  agentId?: string;
  agentVersion?: number;
  agentHash?: string;
}

export const CONFIG_PATH = "ops/sre-agent.json";
export const LOCK_PATH = process.env.SRE_LOCK_PATH ?? "ops/sre-agent.lock.json";

/** owner/name of this checkout, from GitHub Actions or the origin remote. */
export function currentRepository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = tryGit(["remote", "get-url", "origin"])?.trim() ?? "";
  return url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] ?? "";
}

export function toSreTool(entry: RegistryEntry): SreTool {
  return {
    name: entry.name,
    owner: entry.owner,
    githubReviewer: entry.githubReviewer,
    repo: entry.repo,
    baseBranch: entry.baseBranch,
    resourceGroup: entry.resourceGroup,
    containerApp: entry.containerApp,
    logAnalyticsWorkspaceId: entry.logAnalyticsWorkspaceId,
  };
}

/** The agent's settings, plus every tool in the register (ops/tools/). */
export function loadConfig(): SreConfig {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as SreConfig;
  const registered = loadRegistry().map(toSreTool);
  const names = new Set(registered.map((t) => t.name));
  const own = config.tools
    .filter((t) => !names.has(t.name))
    .map((t) => ({ ...t, repo: t.repo || currentRepository() }));
  return { ...config, tools: [...own, ...registered] };
}

export function loadLock(): SreLock {
  return existsSync(LOCK_PATH) ? (JSON.parse(readFileSync(LOCK_PATH, "utf8")) as SreLock) : {};
}

export function saveLock(lock: SreLock) {
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** ANTHROPIC_API_KEY (a GitHub secret in CI), or on a workstation a file outside the repository.
 *  The key is passed straight to the client and never printed. */
export function anthropicClient(): Anthropic {
  if (process.env.ANTHROPIC_API_KEY) return new Anthropic();
  const file = process.env.ANTHROPIC_API_KEY_FILE ?? join(homedir(), ".anthropic", "api-key");
  if (existsSync(file)) {
    const BOM = String.fromCharCode(0xfeff); // Notepad may save one at the start of the file
    const apiKey = readFileSync(file, "utf8").split(BOM).join("").trim();
    if (apiKey) return new Anthropic({ apiKey });
  }
  throw new Error(`No Anthropic API key: set ANTHROPIC_API_KEY, or save the key in ${file}`);
}

export function git(args: string[], cwd = ".", env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function tryGit(args: string[], cwd = "."): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

const run = promisify(execFile);

/** The Azure CLI, already signed in (OIDC in CI, `az login` on a workstation). */
export async function az(args: string[]): Promise<unknown> {
  const { stdout } = await run("az", [...args, "--only-show-errors", "--output", "json"], {
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32", // az is a .cmd file on Windows; long values go via @file
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

/** The first useful line of a failed command's error output. */
export function errorLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw =
    typeof stderr === "string" && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /^(ERROR|error|fatal)/.test(l)) ?? lines[0] ?? raw;
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}
