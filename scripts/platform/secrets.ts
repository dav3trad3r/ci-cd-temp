// Secret scanning of a repository's whole git history, with Gitleaks. A key committed months ago
// and later deleted is still in the history, and it moves with the repository. Reports where a
// secret is and what kind it is, and never the secret itself.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Leak {
  rule: string;
  file: string;
  line: number;
  commit: string;
  /** Gitleaks' ID for this finding, used to record it once the key has been replaced. */
  fingerprint: string;
}

/** Keeps only the location. The report's Secret, Match, Author and Email fields are dropped. */
export function parseLeaks(report: unknown): Leak[] {
  if (!Array.isArray(report)) return [];
  return report.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      rule: String(r.RuleID ?? "unknown"),
      file: String(r.File ?? "unknown"),
      line: Number(r.StartLine ?? 0),
      commit: String(r.Commit ?? "").slice(0, 12),
      fingerprint: String(r.Fingerprint ?? ""),
    };
  });
}

export const leakLine = (l: Leak) =>
  `✗ ${l.file}:${l.line} (${l.rule}) in commit ${l.commit || "unknown"}`;

/** The installed Gitleaks, or undefined. */
export function gitleaksBin(): string | undefined {
  const candidate = process.env.GITLEAKS_BIN || "gitleaks";
  try {
    execFileSync(candidate, ["version"], { stdio: "ignore" });
    return candidate;
  } catch {
    return undefined;
  }
}

/** Scans every commit on every branch. `ignoreFile` lists findings already dealt with. */
export function scanHistory(dir: string, bin: string, ignoreFile?: string): Leak[] {
  const work = mkdtempSync(join(tmpdir(), "platform-gitleaks-"));
  const report = join(work, "report.json");
  try {
    execFileSync(
      bin,
      [
        "git",
        dir,
        "--log-opts=--all",
        "--report-format=json",
        `--report-path=${report}`,
        "--redact",
        "--no-banner",
        "--exit-code=0",
        "--log-level=error",
        ...(ignoreFile ? [`--gitleaks-ignore-path=${ignoreFile}`] : []),
      ],
      // Run from an empty folder, so only the ignore file named above can hide a finding.
      { cwd: work, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 16 * 1024 * 1024 },
    );
    return parseLeaks(JSON.parse(readFileSync(report, "utf8")));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
