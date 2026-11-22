// Applies a validated fix proposal and opens a draft pull request. Nothing here trusts the
// agent: the change is made in a throwaway git worktree, checked with the repository's own
// Guardrails rules, then lint, types and tests run on it. Only a change that passes everything
// is pushed, on an sre-agent/ branch, as a draft for a person to review.
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { findWeakenedChecks, parseAddedLines, parseNameStatus } from "../guardrails.js";
import { errorLine, git, tryGit } from "./config.js";
import { branchName, guardrailProblems, prBody, type FixProposal } from "./fix.js";

const run = promisify(execFile);

export interface FixContext {
  repo: string;
  baseBranch: string;
  incidentId: string;
  tool: string;
  author: { name: string; email: string };
  reviewer?: string;
  sessionUrl: string;
  outDir: string;
}

export interface FixResult {
  ok: boolean;
  problems: string[];
  checks: string[];
  branch?: string;
  prUrl?: string;
  /** Written when no GitHub token is available: the pull request for a person to open. */
  prDraftFile?: string;
}

async function npm(script: string, cwd: string): Promise<{ ok: boolean; tail: string }> {
  try {
    await run("npm", ["run", script, "--silent"], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60_000,
      shell: process.platform === "win32",
    });
    return { ok: true, tail: "" };
  } catch (error) {
    const out = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
    return { ok: false, tail: out.trim().split("\n").slice(-25).join("\n") };
  }
}

function token(): string | undefined {
  return process.env.SRE_AGENT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

async function openPullRequest(
  ctx: FixContext,
  branch: string,
  title: string,
  body: string,
): Promise<string> {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token()}`,
    "User-Agent": "ci-cd-temp-sre-agent",
  };
  const response = await fetch(`https://api.github.com/repos/${ctx.repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title, head: branch, base: ctx.baseBranch, body, draft: true }),
  });
  const pr = (await response.json()) as { html_url?: string; number?: number; message?: string };
  if (!response.ok || !pr.html_url)
    throw new Error(`GitHub refused the pull request: ${pr.message ?? response.status}`);
  if (ctx.reviewer && pr.number) {
    await fetch(`https://api.github.com/repos/${ctx.repo}/pulls/${pr.number}/requested_reviewers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewers: [ctx.reviewer] }),
    });
  }
  return pr.html_url;
}

export async function applyFix(proposal: FixProposal, ctx: FixContext): Promise<FixResult> {
  const checks: string[] = [];
  const base = `origin/${ctx.baseBranch}`;
  git(["fetch", "--quiet", "origin", ctx.baseBranch]);
  const work = mkdtempSync(join(tmpdir(), "sre-fix-"));
  const identity = ["-c", `user.name=${ctx.author.name}`, "-c", `user.email=${ctx.author.email}`];

  try {
    git(["worktree", "add", "--detach", "--quiet", work, base]);
    // Proposals can't change dependencies, so the main checkout's node_modules fits the worktree.
    symlinkSync(resolve("node_modules"), join(work, "node_modules"), "junction");

    if (proposal.kind === "revert") {
      try {
        git([...identity, "revert", "--no-edit", proposal.commit as string], work);
      } catch (error) {
        return {
          ok: false,
          checks,
          problems: [
            `${proposal.commit} doesn't revert cleanly on ${ctx.baseBranch}: ${errorLine(error)}`,
          ],
        };
      }
    } else {
      for (const file of proposal.files ?? []) {
        const target = join(work, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      // House style, so the format check passes: the agent's files go through Prettier.
      const paths = (proposal.files ?? []).map((f) => f.path);
      await run("npx", ["prettier", "--write", "--log-level", "warn", ...paths], {
        cwd: work,
        shell: process.platform === "win32",
      }).catch(() => undefined);
      git(["add", "-A"], work);
      if (!tryGit(["diff", "--cached", "--name-only"], work)?.trim()) {
        return {
          ok: false,
          checks,
          problems: ["the proposed files are identical to the current code"],
        };
      }
      git(
        [
          ...identity,
          "commit",
          "--quiet",
          "-m",
          proposal.title,
          "-m",
          `Proposed by the SRE agent for ${ctx.incidentId}.`,
        ],
        work,
      );
    }
    checks.push(
      `Applied as one commit on ${ctx.baseBranch} (${proposal.kind === "revert" ? `revert of ${proposal.commit}` : `${proposal.files?.length ?? 0} files`})`,
    );

    // The repository's own Guardrails rules, exactly as CI runs them.
    const range = `${base}..HEAD`;
    const findings = findWeakenedChecks({
      files: parseNameStatus(git(["diff", "--name-status", "-M", range], work)),
      addedLines: parseAddedLines(
        git(["diff", "--unified=0", "--no-color", "--no-ext-diff", range], work),
      ),
      readBase: (path) => tryGit(["show", `${base}:${path}`], work),
      readHead: (path) => tryGit(["show", `HEAD:${path}`], work),
    });
    if (findings.length) return { ok: false, checks, problems: guardrailProblems(findings) };
    checks.push("Guardrails rules: no check weakened");

    for (const script of ["lint", "typecheck", "test"]) {
      const result = await npm(script, work);
      if (!result.ok) {
        return {
          ok: false,
          checks,
          problems: [`npm run ${script} failed on the fix:\n${result.tail}`],
        };
      }
      checks.push(`npm run ${script}: passed`);
    }

    const branch = branchName(ctx.incidentId, proposal.title);
    const body = prBody({
      proposal,
      incidentId: ctx.incidentId,
      tool: ctx.tool,
      checks,
      sessionUrl: ctx.sessionUrl,
    });
    const key = token();
    if (key) {
      try {
        git(
          [
            "push",
            "--quiet",
            `https://x-access-token:${key}@github.com/${ctx.repo}.git`,
            `HEAD:refs/heads/${branch}`,
          ],
          work,
        );
      } catch (error) {
        return {
          ok: false,
          checks,
          problems: [`pushing ${branch} failed: ${errorLine(error).split(key).join("***")}`],
        };
      }
      const prUrl = await openPullRequest(ctx, branch, proposal.title, body);
      return { ok: true, checks, problems: [], branch, prUrl };
    }

    // No token on this machine: push with the developer's own git credentials and leave the
    // pull request for a person to open from the saved draft.
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], work);
    mkdirSync(ctx.outDir, { recursive: true });
    const prDraftFile = join(ctx.outDir, "pull-request.json");
    writeFileSync(
      prDraftFile,
      `${JSON.stringify({ repo: ctx.repo, head: branch, base: ctx.baseBranch, title: proposal.title, body, draft: true }, null, 2)}\n`,
    );
    return { ok: true, checks, problems: [], branch, prDraftFile };
  } finally {
    // Remove the node_modules link first, so no clean-up step can follow it into the real one.
    const link = join(work, "node_modules");
    try {
      unlinkSync(link); // a symlink (Linux, macOS)
    } catch {
      try {
        rmdirSync(link); // a junction (Windows): removes the link, not its target
      } catch {
        // no link was made
      }
    }
    tryGit(["worktree", "remove", "--force", work]);
    rmSync(work, { recursive: true, force: true });
  }
}
