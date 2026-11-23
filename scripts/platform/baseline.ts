// The baseline is how an existing tool joins the platform without being blocked by its past.
// When a tool migrates, every check that already fails is written down. From then on:
// - old problems are allowed, and go on a list to work down
// - new problems fail the pull request, and the allowance can only shrink
// - serious problems (secrets in the browser, exposed data) never block a pull request that is
//   trying to fix them, but they do block every deployment until they're gone
// - a tool that can't install or build can't deploy, whatever its baseline says
// - a check that crashed proves nothing, so it never counts as the same old problem
// Pure, so every rule is unit-tested.
import { stripVTControlCharacters } from "node:util";

export const CHECK_ORDER = [
  "install",
  "secrets",
  "format",
  "lint",
  "typecheck",
  "test",
  "build",
  "frontend",
  "data",
  "audit",
  "smoke",
  "eval",
] as const;
export type CheckName = (typeof CHECK_ORDER)[number];

export const CHECK_LABELS: Record<CheckName, string> = {
  install: "Install",
  secrets: "Secrets in git history",
  format: "Format",
  lint: "Lint",
  typecheck: "Types",
  test: "Tests",
  build: "Build",
  frontend: "Secrets in the browser",
  data: "Exposed data",
  audit: "Known vulnerabilities",
  smoke: "Smoke test",
  eval: "AI evaluation",
};

/** Must be fixed before the tool goes live. */
export const SERIOUS: ReadonlySet<CheckName> = new Set(["frontend", "data"]);

/** Without these there's nothing to deploy, so a known failure still stops a release. */
const MUST_WORK: ReadonlySet<CheckName> = new Set(["install", "build"]);

/** A secret can never be accepted as "known": replace the key, then record that you did. */
const NEVER_BASELINED: ReadonlySet<CheckName> = new Set(["secrets"]);

export interface RawResult {
  name: CheckName;
  /** False when the tool has no command for this check. */
  configured: boolean;
  ok: boolean;
  output: string;
  /** Set when the check doesn't apply or couldn't run, with the reason. */
  skipped?: string;
  /** The process was killed or couldn't start, so its output says nothing about the code. */
  crashed?: boolean;
}

export interface BaselineEntry {
  status: "failing" | "missing";
  /** How many problems were counted, when the check's output can be counted. */
  problems: number | null;
  serious?: boolean;
  /** It was already crashing when the tool joined. */
  crashed?: boolean;
}

export interface Baseline {
  version: 1;
  created: string;
  checks: Partial<Record<CheckName, BaselineEntry>>;
}

export type Status = "pass" | "known" | "todo" | "skip" | "fail";

export interface Evaluated {
  name: CheckName;
  status: Status;
  serious: boolean;
  problems: number | null;
  detail: string;
}

const countMatches = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** How many problems a failed check reported, or null if its output can't be counted. */
export function countProblems(name: CheckName, rawOutput: string): number | null {
  const output = stripVTControlCharacters(rawOutput);
  const number = (pattern: RegExp) => {
    const found = output.match(pattern)?.[1];
    return found === undefined ? null : Number(found);
  };
  switch (name) {
    case "typecheck": {
      const errors = countMatches(output, /error TS\d+/g);
      return errors > 0 ? errors : null;
    }
    case "lint": {
      const summary = number(/(\d+) problems?\b/);
      if (summary !== null) return summary;
      const lines = countMatches(output, /^\s*\d+:\d+\s+(?:error|warning)\b/gm);
      return lines > 0 ? lines : null;
    }
    case "test": {
      const tests =
        number(/Tests\s+(\d+) failed/) ?? number(/Tests:\s+(\d+) failed/) ?? number(/# fail (\d+)/);
      // A file that can't load runs none of its tests, so the test count alone hides it.
      const unloaded =
        (number(/Failed Suites (\d+)/) ?? 0) + countMatches(output, /Test suite failed to run/g);
      return tests === null && unloaded === 0 ? null : (tests ?? 0) + unloaded;
    }
    case "format": {
      const files = countMatches(output, /^\[warn\] (?!Code style|Run Prettier).+$/gm);
      return files > 0 ? files : null;
    }
    case "secrets":
    case "frontend":
    case "data": {
      const lines = countMatches(output, /^✗ /gm);
      return lines > 0 ? lines : null;
    }
    case "audit": {
      const counts = [...output.matchAll(/(\d+) (?:high|critical)\b/g)].map((m) => Number(m[1]));
      return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
    }
    default:
      return null;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function evaluate(raw: RawResult, baseline?: Baseline): Evaluated {
  const known = baseline?.checks[raw.name];
  const serious = SERIOUS.has(raw.name);
  const result = (status: Status, detail: string, problems: number | null = null): Evaluated => ({
    name: raw.name,
    status,
    serious,
    problems,
    detail,
  });

  if (raw.skipped) {
    // Not being able to look doesn't mean a serious problem has gone.
    return known?.serious
      ? result("known", `not checked (${raw.skipped}), so it's still open`, known.problems)
      : result("skip", raw.skipped);
  }

  if (!raw.configured) {
    return known?.status === "missing"
      ? result("todo", "not set up yet")
      : result("fail", "this check has no command in .platform/tool.json");
  }

  if (raw.ok) {
    return result(
      "pass",
      known ? "passing now: remove it from the baseline to lock that in" : "passed",
    );
  }

  const count = countProblems(raw.name, raw.output);
  if (NEVER_BASELINED.has(raw.name)) {
    return result("fail", count === null ? "failed" : plural(count, "problem"), count);
  }
  if (known?.status !== "failing") {
    return result(
      "fail",
      count === null ? "failed" : `${plural(count, "problem")}, new since the baseline`,
      count,
    );
  }
  if (raw.crashed && !known.crashed) {
    return result("fail", "crashed or was killed, so it says nothing about the code", count);
  }
  if (known.problems !== null && count === null) {
    return result(
      "fail",
      `stopped without a result (baseline ${known.problems}), so it may have crashed`,
    );
  }
  if (known.problems !== null && count !== null && count > known.problems) {
    return result(
      "fail",
      `${plural(count - known.problems, "new problem")} (baseline ${known.problems}, now ${count})`,
      count,
    );
  }
  const counted = count ?? known.problems;
  return result(
    "known",
    counted === null ? "already failing before migration" : `${plural(counted, "known problem")}`,
    counted,
  );
}

/** A known problem that a pull request may carry, but a release may not. */
export const blocksDeploy = (r: Evaluated) =>
  r.status === "known" && (r.serious || MUST_WORK.has(r.name));

/** Safe to deploy: nothing failing, and no known problem that stops a release. */
export function isReady(results: Evaluated[]): boolean {
  return !results.some((r) => r.status === "fail" || blocksDeploy(r));
}

export function hasFailed(results: Evaluated[]): boolean {
  return results.some((r) => r.status === "fail");
}

/** The first baseline for a tool: everything that fails or is missing today. */
export function makeBaseline(results: RawResult[], created: string): Baseline {
  const checks: Baseline["checks"] = {};
  for (const raw of results) {
    if (raw.skipped || NEVER_BASELINED.has(raw.name)) continue;
    if (!raw.configured) {
      checks[raw.name] = { status: "missing", problems: null };
    } else if (!raw.ok) {
      checks[raw.name] = {
        status: "failing",
        problems: countProblems(raw.name, raw.output),
        ...(SERIOUS.has(raw.name) ? { serious: true } : {}),
        ...(raw.crashed ? { crashed: true } : {}),
      };
    }
  }
  return { version: 1, created, checks };
}

/** Ways a change to a baseline allows MORE problems. Lowering it never needs approval. */
export function baselineLoosened(before: Baseline | undefined, after: Baseline): string[] {
  const changes: string[] = [];
  for (const name of CHECK_ORDER) {
    const was = before?.checks[name];
    const now = after.checks[name];
    if (!now) continue;
    if (!was) {
      changes.push(`${name} was added to the baseline`);
    } else if (was.status === "failing" && now.status === "missing") {
      changes.push(`${name} went from failing to not set up`);
    } else if (was.status === "missing" && now.status === "failing") {
      changes.push(`${name} went from not set up to failing`);
    } else if (now.crashed && !was.crashed) {
      changes.push(`${name} now allows a crash`);
    } else if (was.problems !== null && (now.problems === null || now.problems > was.problems)) {
      changes.push(`${name} allowance went from ${was.problems} to ${now.problems ?? "uncounted"}`);
    }
  }
  return changes;
}
