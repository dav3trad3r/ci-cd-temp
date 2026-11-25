// Applies a validated fix proposal and opens a draft pull request. Nothing here trusts the
// agent: the change is made in a throwaway git worktree and checked with the repository's own
// Guardrails rules. The tool's lint, types and tests then run on a plain copy of that commit in a
// locked-down container, which has no credentials, no git and no network. Only the exact commit
// that passed is pushed, on an sre-agent/ branch, as a draft for a person to review.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findWeakenedChecks, parseAddedLines, parseNameStatus } from "../guardrails.js";
import { CHECK_LABELS, evaluate } from "../platform/baseline.js";
import { hasManifest, loadManifest, type Manifest } from "../platform/model.js";
import { collectResults, loadBaseline } from "../platform/run-checks.js";
import {
  createSandbox,
  dockerAvailable,
  exportCommit,
  installCommand,
  runInSandbox,
} from "../platform/sandbox.js";
import { errorLine, git, tryGit } from "./config.js";
import { branchName, guardrailProblems, prBody, type FixProposal } from "./fix.js";
import { gitAuthEnv, githubToken } from "./target.js";

export interface FixContext {
  repo: string;
  /** The checkout of that repository. */
  repoDir: string;
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

/** For the platform repository itself, which has no .platform/tool.json. */
const OWN_CHECKS: Manifest = {
  name: "platform",
  kind: "new",
  owner: "platform@example.com",
  stack: "node",
  nodeVersion: "22",
  packageManager: "npm",
  commands: {
    install: "npm ci --no-audit --no-fund",
    format: null,
    lint: "npm run lint --silent",
    typecheck: "npm run typecheck --silent",
    test: "npm test --silent",
    build: null,
    smoke: null,
    eval: null,
  },
  webDir: null,
  start: null,
  migrate: null,
  migratesAtStartup: false,
  port: 8080,
  healthPath: "/",
  dockerfile: null,
};

const token = githubToken;

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

/** The same comparison CI's Guardrails makes, on the fix as committed. */
function guardrailFindings(work: string, base: string) {
  const range = `${base}..HEAD`;
  return findWeakenedChecks({
    files: parseNameStatus(git(["diff", "--name-status", "-z", "-M", range], work)),
    addedLines: parseAddedLines(
      git(
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--unified=0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--text",
          range,
        ],
        work,
      ),
    ),
    readBase: (path) => tryGit(["show", `${base}:${path}`], work),
    readHead: (path) => tryGit(["show", `HEAD:${path}`], work),
  });
}

/** Brings Prettier's output back from the sandbox: only the fix's own files, and only if plain. */
function copyFormatted(paths: string[], from: string, to: string) {
  for (const path of paths) {
    const source = join(from, path);
    const info = lstatSync(source, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > 1_000_000) continue;
    writeFileSync(join(to, path), readFileSync(source));
  }
}

export async function applyFix(proposal: FixProposal, ctx: FixContext): Promise<FixResult> {
  const checks: string[] = [];
  // The agent's code never runs on this machine, which holds the pipeline's credentials.
  if (!dockerAvailable()) {
    return {
      ok: false,
      checks,
      problems: [
        "Docker isn't available, so this fix can't be tested safely. Nothing was changed.",
      ],
    };
  }
  const base = `origin/${ctx.baseBranch}`;
  git(["fetch", "--quiet", "origin", ctx.baseBranch], ctx.repoDir, gitAuthEnv());
  const work = mkdtempSync(join(tmpdir(), "sre-fix-"));
  const sandboxRoot = mkdtempSync(join(tmpdir(), "sre-sandbox-"));
  const identity = [
    "-c",
    `user.name=${ctx.author.name}`,
    "-c",
    `user.email=${ctx.author.email}`,
    "-c",
    "core.hooksPath=/dev/null",
  ];

  try {
    git(["worktree", "add", "--detach", "--quiet", work, base], ctx.repoDir);

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

    // Guardrails first, so a fix that changes the checks never gets to run.
    const early = guardrailFindings(work, base);
    if (early.length) return { ok: false, checks, problems: guardrailProblems(early) };

    const manifest = hasManifest(work) ? loadManifest(work) : OWN_CHECKS;
    const baseline = loadBaseline(work);
    const box = createSandbox(sandboxRoot, manifest);
    exportCommit(work, "HEAD", box.dir);

    // Install is the only step with network access, and it has no credentials to send anywhere.
    if (manifest.commands.install) {
      const installed = await runInSandbox(
        box,
        installCommand(manifest, manifest.commands.install),
        { network: true },
      );
      if (!installed.ok) {
        const tail = installed.output.trim().split("\n").slice(-25).join("\n");
        return { ok: false, checks, problems: [`Install failed in the sandbox:\n${tail}`] };
      }
    }

    // House style, so the format check passes: the agent's files go through Prettier.
    const paths = (proposal.files ?? []).map((f) => f.path);
    if (paths.length) {
      const quoted = paths.map((p) => `'${p}'`).join(" ");
      await runInSandbox(box, `npx --no-install prettier --write --log-level warn ${quoted}`);
      copyFormatted(paths, box.dir, work);
      git(["add", "-A"], work);
      if (tryGit(["diff", "--cached", "--name-only"], work)?.trim()) {
        git([...identity, "commit", "--quiet", "--amend", "--no-edit"], work);
      }
    }

    // The repository's own Guardrails rules, exactly as CI runs them.
    const findings = guardrailFindings(work, base);
    if (findings.length) return { ok: false, checks, problems: guardrailProblems(findings) };
    checks.push("Guardrails rules: no check weakened");

    // This exact commit is what gets pushed, whatever the checks do to their copy of the files.
    const candidate = git(["rev-parse", "HEAD"], work).trim();
    const clean = createSandbox(sandboxRoot, manifest, "checked");
    exportCommit(work, candidate, clean.dir);
    if (existsSync(join(box.dir, "node_modules"))) {
      renameSync(join(box.dir, "node_modules"), join(clean.dir, "node_modules"));
    }

    // The tool's own commands, compared with its baseline: a fix can't add a new problem.
    const raw = await collectResults({
      dir: clean.dir,
      manifest,
      only: ["lint", "typecheck", "test"],
      installed: true,
      runner: (command) => runInSandbox(clean, command),
    });
    for (const result of raw) {
      const verdict = evaluate(result, baseline);
      if (verdict.status === "fail") {
        const tail = result.output.trim().split("\n").slice(-25).join("\n");
        return {
          ok: false,
          checks,
          problems: [`${CHECK_LABELS[result.name]} failed on the fix: ${verdict.detail}\n${tail}`],
        };
      }
      if (verdict.status === "pass" || verdict.status === "known") {
        checks.push(`${CHECK_LABELS[result.name]}: ${verdict.detail}`);
      }
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
            `https://github.com/${ctx.repo}.git`,
            `${candidate}:refs/heads/${branch}`,
          ],
          work,
          gitAuthEnv(key),
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
    try {
      git(["push", "--quiet", "origin", `${candidate}:refs/heads/${branch}`], work);
    } catch (error) {
      return {
        ok: false,
        checks,
        problems: [`every check passed, but pushing ${branch} failed: ${errorLine(error)}`],
      };
    }
    mkdirSync(ctx.outDir, { recursive: true });
    const prDraftFile = join(ctx.outDir, "pull-request.json");
    writeFileSync(
      prDraftFile,
      `${JSON.stringify({ repo: ctx.repo, head: branch, base: ctx.baseBranch, title: proposal.title, body, draft: true }, null, 2)}\n`,
    );
    return { ok: true, checks, problems: [], branch, prDraftFile };
  } finally {
    tryGit(["worktree", "remove", "--force", work], ctx.repoDir);
    rmSync(work, { recursive: true, force: true });
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}
