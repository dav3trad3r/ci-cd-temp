// Which repository an incident's code lives in. The agent runs from the platform repository and
// works on any registered tool, so it clones that tool's repository for the incident.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentRepository, git, type SreTool } from "./config.js";

export interface RepoCheckout {
  dir: string;
  cleanup: () => void;
}

export function githubToken(): string | undefined {
  return process.env.SRE_AGENT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

/** Gives git the token through its environment, so it's never in a URL, argument or file. A
 *  token in .git/config could be read by the tests that run against an agent's fix. */
export function gitAuthEnv(token = githubToken()): NodeJS.ProcessEnv | undefined {
  if (!token) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export function checkoutTool(tool: SreTool): RepoCheckout {
  if (tool.repo === currentRepository()) return { dir: ".", cleanup: () => undefined };
  const dir = mkdtempSync(join(tmpdir(), `sre-${tool.name}-`));
  git(
    ["clone", "--quiet", "--branch", tool.baseBranch, `https://github.com/${tool.repo}.git`, dir],
    ".",
    gitAuthEnv(),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
