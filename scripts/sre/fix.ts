// Rules for the SRE agent's proposed fixes. Pure functions, unit-tested in
// tests/unit/sre-agent.test.ts. apply-fix.ts then applies a proposal that passes these
// rules, runs the repository's own Guardrails rules and checks on it, and opens a draft PR.
import type { Finding } from "../guardrails.js";

export interface FileChange {
  path: string;
  content: string;
}

export interface FixProposal {
  kind: "revert" | "code_fix";
  title: string;
  summary: string;
  evidence: string;
  confidence: number;
  commit?: string;
  files?: FileChange[];
}

export const LIMITS = {
  minConfidence: 70,
  maxFiles: 6,
  maxFileBytes: 100_000,
  maxTotalBytes: 200_000,
};

/** Files the agent may never change: a dependency or the lockfile needs a person (AGENTS.md). */
const OFF_LIMITS = ["package.json", "package-lock.json", ".env", ".env.example"];

/** A plain relative path inside the repository: no "..", no absolute paths, nothing in .git. */
export function safePath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("\\")) return false;
  if (!/^[\w.@()/-]+$/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return parts[0] !== ".git";
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Checks a propose_fix call before anything touches git. Every problem is listed, so the agent
 *  can correct them all in one go. */
export function validateProposal(input: unknown): { proposal?: FixProposal; problems: string[] } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const kind = raw.kind;
  if (kind !== "revert" && kind !== "code_fix")
    problems.push('kind must be "revert" or "code_fix"');

  const title = text(raw.title);
  if (title.length < 10 || title.length > 100) problems.push("title must be 10 to 100 characters");
  const summary = text(raw.summary);
  if (summary.length < 20) problems.push("summary must explain the fix for the reviewer");
  const evidence = text(raw.evidence);
  if (evidence.length < 20)
    problems.push("evidence must give the timing, the error and the changed code");
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < LIMITS.minConfidence) {
    problems.push(
      `confidence must be at least ${LIMITS.minConfidence}; below that, post what you know instead`,
    );
  }

  const proposal: FixProposal = {
    kind: kind === "revert" ? "revert" : "code_fix",
    title,
    summary,
    evidence,
    confidence,
  };

  if (kind === "revert") {
    const commit = text(raw.commit).toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(commit))
      problems.push("commit must be the commit's SHA (7 to 40 hex characters)");
    proposal.commit = commit;
  }

  if (kind === "code_fix") {
    const files = Array.isArray(raw.files) ? raw.files : [];
    if (files.length === 0 || files.length > LIMITS.maxFiles) {
      problems.push(`files must list 1 to ${LIMITS.maxFiles} changed files`);
    }
    const seen = new Set<string>();
    let total = 0;
    const clean: FileChange[] = [];
    for (const f of files as Record<string, unknown>[]) {
      const path = text(f?.path);
      const content = typeof f?.content === "string" ? f.content : null;
      if (!safePath(path)) {
        problems.push(`"${path}" isn't a plain path inside the repository`);
        continue;
      }
      if (OFF_LIMITS.includes(path)) problems.push(`${path} needs a person to change it`);
      if (seen.has(path)) problems.push(`${path} is listed twice`);
      seen.add(path);
      if (content === null) {
        problems.push(`${path} has no content`);
        continue;
      }
      const bytes = Buffer.byteLength(content, "utf8");
      total += bytes;
      if (bytes > LIMITS.maxFileBytes)
        problems.push(`${path} is over ${LIMITS.maxFileBytes / 1000} kB`);
      clean.push({ path, content });
    }
    if (total > LIMITS.maxTotalBytes)
      problems.push(`the change is over ${LIMITS.maxTotalBytes / 1000} kB in total`);
    if (
      !clean.some((f) => f.path.startsWith("tests/regressions/") && f.path.endsWith(".test.ts"))
    ) {
      problems.push("a code fix must add or update a dated regression test in tests/regressions/");
    }
    proposal.files = clean;
  }

  return problems.length ? { problems } : { proposal, problems };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function branchName(incidentId: string, title: string): string {
  return `sre-agent/${slug(incidentId)}-${slug(title).slice(0, 40).replace(/-+$/, "")}`;
}

export function guardrailProblems(findings: Finding[]): string[] {
  return findings.map(
    (f) =>
      `the Guardrails rules refuse this change (${f.rule}: ${f.detail}); fix the code, not the check`,
  );
}

export function prBody(args: {
  proposal: FixProposal;
  incidentId: string;
  tool: string;
  checks: string[];
  sessionUrl: string;
}): string {
  const { proposal: p } = args;
  return [
    `**Proposed by the SRE agent for ${args.incidentId} on ${args.tool}.** A person must review this before it merges; the agent can't merge or deploy.`,
    "",
    "## What it changes",
    "",
    p.summary,
    "",
    "## Evidence",
    "",
    p.evidence,
    "",
    `Confidence: ${p.confidence}%`,
    "",
    "## Checked before opening",
    "",
    ...args.checks.map((c) => `- ${c}`),
    "",
    `Agent session (full transcript): ${args.sessionUrl}`,
    "",
    "🤖 Opened by the SRE agent (Claude Managed Agents)",
  ].join("\n");
}
