// 2026-11-23: an SRE agent's proposed fix ran on the same machine as the pipeline. With fake values,
// a test could read the GitHub token from its parent process, reach the Azure login cache, and
// change the commit after Guardrails had passed it. A fix now runs in a locked-down container with
// a plain copy of the commit, and only that recorded commit can be pushed. The self-test proves
// this against real Docker in CI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  dockerAvailable,
  exportCommit,
  installCommand,
  sandboxArgs,
  sandboxImage,
} from "../../scripts/platform/sandbox.js";
import { applyFix } from "../../scripts/sre/apply-fix.js";

const box = { dir: "/tmp/fix/code", cache: "/tmp/fix/cache", image: "node:22-slim" };
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const all = (args: string[], flag: string) =>
  args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));

describe("the container an unreviewed fix runs in", () => {
  test("has no network unless it's installing", () => {
    expect(value(sandboxArgs(box, "npm test"), "--network")).toBe("none");
    expect(value(sandboxArgs(box, "npm ci", { network: true }), "--network")).toBe("bridge");
  });

  test("is locked down", () => {
    const args = sandboxArgs(box, "npm test", { user: "1001:1001" });
    expect(args).toContain("--read-only");
    expect(value(args, "--cap-drop")).toBe("ALL");
    expect(value(args, "--security-opt")).toBe("no-new-privileges");
    expect(value(args, "--user")).toBe("1001:1001");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--pid");
  });

  test("can see only its own copy of the code and a throwaway cache", () => {
    const mounts = all(sandboxArgs(box, "npm test"), "--mount");
    expect(mounts).toHaveLength(2);
    expect(mounts.map((m) => m.split(",").at(-1))).toEqual(["dst=/work", "dst=/cache"]);
    expect(mounts.join(" ")).not.toContain("docker.sock");
  });

  test("receives no setting from this machine", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-key");
    vi.stubEnv("SRE_AGENT_GITHUB_TOKEN", "fake-token");
    const args = sandboxArgs(box, "npm test");
    vi.unstubAllEnvs();
    expect(args.join(" ")).not.toContain("fake-");
    expect(all(args, "--env").map((e) => e.split("=")[0])).toEqual([
      "HOME",
      "PATH",
      "COREPACK_HOME",
      "COREPACK_ENABLE_DOWNLOAD_PROMPT",
      "npm_config_cache",
      "CI",
      "NO_COLOR",
      "FORCE_COLOR",
    ]);
  });

  test("uses the tool's runtime", () => {
    expect(sandboxImage({ packageManager: "npm", nodeVersion: "24" })).toBe("node:24-slim");
    expect(sandboxImage({ packageManager: "bun", nodeVersion: "22" })).toBe("oven/bun:1-slim");
    expect(installCommand({ packageManager: "npm" }, "npm ci")).toBe("npm ci");
    expect(installCommand({ packageManager: "pnpm" }, "pnpm i")).toContain("corepack enable");
  });
});

describe("the copy of the commit", () => {
  const made: string[] = [];
  const temp = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), name));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("has no git directory, and a repository's export rules can't drop files", () => {
    const repo = temp("sandbox-repo-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: repo,
        encoding: "utf8",
      });
    git("init", "-q");
    writeFileSync(join(repo, ".gitattributes"), "a.test.js export-ignore\n");
    writeFileSync(join(repo, "a.test.js"), "committed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    writeFileSync(join(repo, "a.test.js"), "not committed\n");

    const dest = join(temp("sandbox-copy-"), "code");
    exportCommit(repo, git("rev-parse", "HEAD").trim(), dest);
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(readFileSync(join(dest, "a.test.js"), "utf8").trim()).toBe("committed");
    expect(git("status", "--short")).toContain("a.test.js");
  });
});

test("without Docker a fix is refused, rather than run on the pipeline's machine", async () => {
  vi.stubEnv("PLATFORM_DOCKER_BIN", "docker-that-does-not-exist");
  try {
    expect(dockerAvailable()).toBe(false);
    const result = await applyFix(
      {
        kind: "code_fix",
        title: "A fix",
        summary: "s",
        evidence: "e",
        confidence: 90,
        files: [{ path: "a.js", content: "1" }],
      },
      {
        repo: "acme/tool",
        repoDir: "does-not-exist",
        baseBranch: "main",
        incidentId: "INC-1",
        tool: "tool",
        author: { name: "a", email: "a@example.com" },
        sessionUrl: "https://example.invalid",
        outDir: "does-not-exist",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("Docker");
  } finally {
    vi.unstubAllEnvs();
  }
});
