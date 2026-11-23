// Guardrails check: fails a pull request that weakens the checks instead of fixing the code.
//
// In CI it compares the pull request with its base branch and fails if it finds a
// skipped or deleted test, a raised budget, a lowered AI baseline, a silenced linter,
// a changed check script, or an edit to the files that decide what gets checked.
// A person approves an intended change by adding the "guardrail-change" label.
//
// Run locally (npm run check:guardrails) it compares your commits with origin/main and
// only warns, so you can see what a reviewer will be asked to approve.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { findWeakenedChecks, parseAddedLines, parseNameStatus } from "./guardrails.js";

const APPROVAL_LABEL = "guardrail-change";
const inCi = process.env.GITHUB_ACTIONS === "true";
const base =
  process.env.GUARDRAIL_BASE ??
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");

const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });

function tryGit(...args: string[]): string | undefined {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
}

if (tryGit("rev-parse", "--verify", "--quiet", `${base}^{commit}`) === undefined) {
  console.log(`Guardrails: no ${base} to compare with, so there is nothing to check.`);
  process.exit(0);
}

const mergeBase = git("merge-base", base, "HEAD").trim();
const range = `${mergeBase}..HEAD`;

let labels: string[] = [];
let author: string | undefined;
if (process.env.GITHUB_EVENT_PATH) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) as {
    pull_request?: { labels?: { name: string }[]; user?: { login: string } };
  };
  labels = event.pull_request?.labels?.map((l) => l.name) ?? [];
  author = event.pull_request?.user?.login;
}

const findings = findWeakenedChecks({
  files: parseNameStatus(git("diff", "--name-status", "-z", "-M", range)),
  // --text and --no-textconv, so marking a file as binary can't hide what was added to it.
  addedLines: parseAddedLines(
    git(
      "-c",
      "core.quotePath=false",
      "diff",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--text",
      range,
    ),
  ),
  readBase: (path) => tryGit("show", `${mergeBase}:${path}`),
  readHead: (path) => tryGit("show", `HEAD:${path}`),
  author,
});

const approved = labels.includes(APPROVAL_LABEL);
const report = findings.length
  ? [
      `Guardrails: ${findings.length} change${findings.length === 1 ? "" : "s"} weaken or alter the checks:`,
      ...findings.map((f) => `- ${f.rule}: ${f.detail}`),
      approved
        ? `Approved: a person added the "${APPROVAL_LABEL}" label.`
        : `If this is intended, explain why in the pull request and have a person add the "${APPROVAL_LABEL}" label. Otherwise fix the code, not the check.`,
    ].join("\n")
  : "Guardrails: no checks weakened.";

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

if (findings.length && !approved && inCi) process.exit(1);
