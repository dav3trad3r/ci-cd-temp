import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { findWeakenedChecks } from "../../scripts/guardrails.js";
import {
  branchName,
  guardrailProblems,
  prBody,
  safePath,
  validateProposal,
} from "../../scripts/sre/fix.js";
import { CUSTOM_TOOLS, demoRead, safeFilter, type DemoIncident } from "../../scripts/sre/tools.js";

const goodFix = {
  kind: "code_fix",
  title: "Fix the due-soon query's column name",
  summary: "The due-soon route ordered by a column that doesn't exist. It now orders by due_at.",
  evidence:
    "500s began 6 minutes after the deploy; every error names due_date; the deploy added it.",
  confidence: 95,
  files: [
    { path: "src/server/app.ts", content: "export {};\n" },
    { path: "tests/regressions/2026-11-22-due-soon-column.test.ts", content: "export {};\n" },
  ],
};

describe("fix proposals", () => {
  test("a code fix with a dated regression test is accepted", () => {
    const { proposal, problems } = validateProposal(goodFix);
    expect(problems).toEqual([]);
    expect(proposal?.files).toHaveLength(2);
  });

  test("a code fix without a regression test is refused", () => {
    const { problems } = validateProposal({ ...goodFix, files: [goodFix.files[0]] });
    expect(problems).toContain(
      "a code fix must add or update a dated regression test in tests/regressions/",
    );
  });

  test("low confidence, missing evidence and a short title are all reported at once", () => {
    const { problems } = validateProposal({
      ...goodFix,
      confidence: 55,
      evidence: "trust me",
      title: "fix",
    });
    expect(problems).toHaveLength(3);
  });

  test("dependencies and paths outside the repository are off limits", () => {
    const { problems } = validateProposal({
      ...goodFix,
      files: [
        ...goodFix.files,
        { path: "package.json", content: "{}" },
        { path: "../outside.ts", content: "" },
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        '"../outside.ts" isn\'t a plain path inside the repository',
        "package.json needs a person to change it",
      ]),
    );
  });

  test("a revert needs a commit SHA", () => {
    expect(
      validateProposal({ ...goodFix, kind: "revert", files: undefined, commit: "50fbc9d" })
        .problems,
    ).toEqual([]);
    expect(
      validateProposal({ ...goodFix, kind: "revert", files: undefined, commit: "HEAD~1" }).problems,
    ).toContain("commit must be the commit's SHA (7 to 40 hex characters)");
  });

  test("only plain relative paths are safe", () => {
    expect(safePath("src/server/app.ts")).toBe(true);
    for (const bad of [
      "/etc/passwd",
      "a/../b",
      ".git/config",
      "src\\app.ts",
      "a//b",
      "a/./b",
      "",
    ]) {
      expect(safePath(bad)).toBe(false);
    }
  });

  test("the agent's branches are named after the incident", () => {
    expect(branchName("INC-DEMO-1042", "Fix the due-soon query's column name!")).toBe(
      "sre-agent/inc-demo-1042-fix-the-due-soon-query-s-column-name",
    );
  });

  test("a fix that weakens a check is refused with the Guardrails rule that caught it", () => {
    const findings = findWeakenedChecks({
      files: [{ status: "M", path: "tests/unit/x.test.ts" }],
      addedLines: [{ path: "tests/unit/x.test.ts", line: 'it.skip("flaky", () => {' }],
      readBase: () => undefined,
      readHead: () => undefined,
    });
    expect(guardrailProblems(findings)[0]).toMatch(
      /^the Guardrails rules refuse this change \(test skipped/,
    );
  });

  test("the pull request says a person must review it, and shows the evidence and checks", () => {
    const { proposal } = validateProposal(goodFix);
    const body = prBody({
      proposal: proposal!,
      incidentId: "INC-DEMO-1042",
      tool: "demo-tool",
      checks: ["npm run test: passed"],
      sessionUrl: "https://platform.claude.com/x",
    });
    expect(body).toContain("A person must review this before it merges");
    expect(body).toContain(goodFix.evidence);
    expect(body).toContain("- npm run test: passed");
  });
});

describe("demo tools", () => {
  const incident = JSON.parse(readFileSync("sre/demo/incident.json", "utf8")) as DemoIncident;
  const firedAt = new Date("2026-11-22T05:00:00Z"); // 3 pm AEST

  test("error logs can be filtered to one route", () => {
    const lines = demoRead(
      "get_logs",
      { level: "error", contains: "due-soon" },
      incident,
      firedAt,
    ).split("\n");
    expect(lines[0]).toBe("(demo: a sample of log lines)");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.slice(1).every((l) => l.includes("ERROR GET /api/items/due-soon 500"))).toBe(true);
  });

  test("a log filter that isn't plain text is refused, not pasted into a query", () => {
    expect(safeFilter("due-soon")).toBe("due-soon");
    expect(safeFilter("x' | delete")).toBeNull();
    expect(demoRead("get_logs", { contains: "x' | delete" }, incident, firedAt)).toMatch(
      /^Refused/,
    );
  });

  test("metrics show 5xx starting after the deploy, with steady traffic", () => {
    const rows = demoRead("get_metrics", { minutes_before: 15 }, incident, firedAt).split("\n");
    expect(rows[0]).toBe("5 minutes from (AEST) | requests | 5xx | p95 ms");
    expect(rows.slice(1).map((r) => Number(r.split(" | ")[2]))).toEqual([0, 5, 14]);
  });

  // The first demo run (22 Nov) caught this: the metrics counted errors in windows that ended
  // before the deploy, which the logs contradicted, so the agent rightly lowered its confidence.
  test("no 5-minute window that ends before the deploy has any errors", () => {
    const m = incident.metrics;
    m.requests_5xx.forEach((errors, i) => {
      const windowEndsMinutesBefore =
        m.startMinutesBeforeAlert - i * m.intervalMinutes - m.intervalMinutes;
      if (windowEndsMinutesBefore >= incident.deployMinutesBeforeAlert) expect(errors).toBe(0);
    });
  });

  test("get_diff only accepts a commit SHA", () => {
    expect(demoRead("get_diff", { commit: "main; rm -rf /" }, incident, firedAt)).toMatch(
      /^Refused/,
    );
  });

  test("every custom tool has a unique name and an input schema", () => {
    const names = CUSTOM_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(CUSTOM_TOOLS.every((t) => t.input_schema.type === "object")).toBe(true);
  });
});

describe("the agent's instructions", () => {
  test("say it never weakens a check and never changes production itself", () => {
    const system = readFileSync("sre/agent/system.md", "utf8");
    expect(system).toContain("Never weaken a check");
    expect(system).toContain("You never change production yourself");
  });
});
