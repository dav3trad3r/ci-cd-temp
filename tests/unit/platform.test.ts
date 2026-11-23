import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { findWeakenedChecks, type ChangeSet } from "../../scripts/guardrails.js";
import {
  baselineLoosened,
  countProblems,
  evaluate,
  isReady,
  makeBaseline,
  type Baseline,
  type RawResult,
} from "../../scripts/platform/baseline.js";
import {
  answering,
  canRelease,
  hasRequiredReviewers,
  labelledRevision,
  labelUrl,
  liveRevision,
  revisionSuffix,
  revisionVerdict,
} from "../../scripts/platform/deploy.js";
import { detectStack, GENERATED_DOCKERFILE } from "../../scripts/platform/detect.js";
import { isSensitive, safeEnv } from "../../scripts/platform/env.js";
import { findUnprotectedTables, usesSupabase } from "../../scripts/platform/exposure.js";
import {
  manifestSchema,
  newRegistryEntry,
  type Manifest,
  type Settings,
} from "../../scripts/platform/model.js";
import { parseLeaks } from "../../scripts/platform/secrets.js";
import {
  bicepParamFile,
  codeOwnersFile,
  dockerfileFor,
  mergeClaudeSettings,
  mergeManagedBlock,
  workflowFile,
} from "../../scripts/platform/tool-files.js";
import { emptyFacts, parseAdoption, parseWhatIf, repoQuery } from "../../scripts/report/model.js";
import { decisions, renderPlain } from "../../scripts/report/render.js";

const settings: Settings = {
  org: "acme",
  platformRepo: "ci-cd-temp",
  approversTeam: "pipeline-approvers",
  azure: {
    environmentId: "/subscriptions/x/env",
    actionGroupId: "/subscriptions/x/ag",
    registryName: "acracme",
    registryResourceGroup: "rg-platform",
    costCentre: "OPS",
  },
};

const manifest: Manifest = manifestSchema.parse({
  name: "notes-tool",
  kind: "migrated",
  owner: "sam@example.com",
  stack: "node",
  nodeVersion: "22",
  packageManager: "npm",
  commands: {
    install: "npm ci --no-audit --no-fund",
    format: null,
    lint: "npm run lint",
    typecheck: null,
    test: null,
    build: "npm run build",
    smoke: null,
    eval: null,
  },
  webDir: "dist",
  start: "npm run start",
  port: 3000,
  healthPath: "/",
  dockerfile: GENERATED_DOCKERFILE,
});

const failing = (name: RawResult["name"], output = ""): RawResult => ({
  name,
  configured: true,
  ok: false,
  output,
});

describe("working out how an existing tool builds", () => {
  test("a Next.js tool on pnpm", () => {
    const found = detectStack({
      files: ["package.json", "pnpm-lock.yaml", "tsconfig.json"],
      packageJson: {
        scripts: { build: "next build", start: "next start", lint: "next lint" },
        dependencies: { next: "16.0.0" },
        devDependencies: { typescript: "6.0.0" },
      },
    });
    expect(found.packageManager).toBe("pnpm");
    expect(found.commands.install).toBe("pnpm install --frozen-lockfile");
    expect(found.commands.lint).toBe("pnpm run lint");
    expect(found.commands.typecheck).toBe("pnpm exec tsc --noEmit");
    expect(found.webDir).toBe(".next/static");
    expect(found.dockerfile).toBe(GENERATED_DOCKERFILE);
  });

  test("npm init's placeholder test script doesn't count as tests", () => {
    const found = detectStack({
      files: ["package.json"],
      packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } },
    });
    expect(found.commands.test).toBeNull();
    expect(found.commands.install).toBe("npm install --no-audit --no-fund");
  });

  test("a tool's own Dockerfile and port are kept", () => {
    const found = detectStack({
      files: ["package.json", "Dockerfile", "package-lock.json"],
      packageJson: { scripts: { start: "node server.js" } },
      dockerfile: "FROM node:22\nEXPOSE 3001\n",
    });
    expect(found.dockerfile).toBe("Dockerfile");
    expect(found.port).toBe(3001);
  });

  test("Vite's own output folder is respected", () => {
    const found = detectStack({
      files: ["package.json", "vite.config.ts"],
      packageJson: { devDependencies: { vite: "8.0.0" } },
      viteConfig: 'export default { build: { outDir: "../public-site" } }',
    });
    expect(found.webDir).toBe("public-site");
  });

  test("a tool in another language still joins, with its checks as to-dos", () => {
    const found = detectStack({ files: ["requirements.txt", "app.py"] });
    expect(found.stack).toBe("unknown");
    expect(found.commands.test).toBeNull();
  });
});

describe("the baseline: old problems allowed, new ones not", () => {
  const baseline: Baseline = {
    version: 1,
    created: "2026-11-23",
    checks: {
      lint: { status: "failing", problems: 5 },
      test: { status: "missing", problems: null },
      data: { status: "failing", problems: 1, serious: true },
    },
  };

  test("counts problems from real tool output, with or without colour", () => {
    expect(countProblems("lint", "✖ 73 problems (70 errors, 3 warnings)")).toBe(73);
    expect(countProblems("typecheck", "a.ts(1,1): error TS2322\nb.ts(2,2): error TS2345")).toBe(2);
    expect(countProblems("test", "      Tests  3 failed | 70 passed (73)")).toBe(3);
    const esc = String.fromCharCode(27);
    const coloured = `[${esc}[33mwarn${esc}[39m] a.ts\n[${esc}[33mwarn${esc}[39m] Code style issues found in 1 file.`;
    expect(countProblems("format", coloured)).toBe(1);
    expect(countProblems("audit", "8 vulnerabilities (2 moderate, 5 high, 1 critical)")).toBe(6);
  });

  test("the same or fewer problems pass, and one more fails", () => {
    expect(evaluate(failing("lint", "✖ 5 problems"), baseline).status).toBe("known");
    expect(evaluate(failing("lint", "✖ 4 problems"), baseline).status).toBe("known");
    const worse = evaluate(failing("lint", "✖ 6 problems"), baseline);
    expect(worse.status).toBe("fail");
    expect(worse.detail).toContain("1 new problem");
  });

  test("a check that wasn't failing before can't start failing", () => {
    expect(evaluate(failing("build"), baseline).status).toBe("fail");
  });

  test("a missing check is a to-do for a migrated tool, and a failure for a new one", () => {
    const missing: RawResult = { name: "test", configured: false, ok: false, output: "" };
    expect(evaluate(missing, baseline).status).toBe("todo");
    expect(evaluate(missing, undefined).status).toBe("fail");
  });

  test("a secret can never be accepted onto the baseline", () => {
    const leak = failing("secrets", "✗ a.js:1 (github-pat) in commit abc");
    expect(makeBaseline([leak], "2026-11-23").checks.secrets).toBeUndefined();
    const withEntry: Baseline = {
      ...baseline,
      checks: { secrets: { status: "failing", problems: 1 } },
    };
    expect(evaluate(leak, withEntry).status).toBe("fail");
  });

  test("a serious issue lets a pull request through but blocks deployment", () => {
    const results = [evaluate(failing("data", "✗ table open"), baseline)];
    expect(results[0]?.status).toBe("known");
    expect(isReady(results)).toBe(false);
    expect(isReady([evaluate(failing("lint", "✖ 5 problems"), baseline)])).toBe(true);
  });

  test("lowering the baseline is free, and raising it isn't", () => {
    const lowered: Baseline = {
      ...baseline,
      checks: { ...baseline.checks, lint: { status: "failing", problems: 2 } },
    };
    expect(baselineLoosened(baseline, lowered)).toEqual([]);
    const raised: Baseline = {
      ...baseline,
      checks: { ...baseline.checks, lint: { status: "failing", problems: 9 } },
    };
    expect(baselineLoosened(baseline, raised)[0]).toContain("from 5 to 9");
    const added: Baseline = {
      ...baseline,
      checks: { ...baseline.checks, build: { status: "failing", problems: null } },
    };
    expect(baselineLoosened(baseline, added)[0]).toContain("build");
  });
});

describe("guardrails on a tool's baseline", () => {
  const change = (before: Baseline, after: Baseline): ChangeSet => ({
    files: [{ status: "M", path: ".platform/baseline.json" }],
    addedLines: [],
    readBase: (p) => (p === ".platform/baseline.json" ? JSON.stringify(before) : undefined),
    readHead: (p) => (p === ".platform/baseline.json" ? JSON.stringify(after) : undefined),
  });
  const at = (problems: number): Baseline => ({
    version: 1,
    created: "2026-11-23",
    checks: { lint: { status: "failing", problems } },
  });

  test("working it down needs no approval", () => {
    expect(findWeakenedChecks(change(at(5), at(4)))).toEqual([]);
  });

  test("raising it is flagged", () => {
    expect(findWeakenedChecks(change(at(5), at(6)))[0]?.rule).toBe("baseline raised");
  });

  test("other platform files, and the list of accepted secrets, are guarded", () => {
    for (const path of [".platform/tool.json", ".gitleaksignore"]) {
      const findings = findWeakenedChecks({
        files: [{ status: "M", path }],
        addedLines: [],
        readBase: () => undefined,
        readHead: () => undefined,
      });
      expect(findings[0]?.rule).toBe("guarded file changed");
    }
  });
});

describe("exposed data", () => {
  test("finds a public table without row-level security", () => {
    expect(
      findUnprotectedTables([{ path: "m/1.sql", text: "create table public.notes (id int);" }]),
    ).toEqual(['✗ m/1.sql: table "notes" has no row-level security.']);
  });

  test("a later migration that secures or drops the table clears it", () => {
    expect(
      findUnprotectedTables([
        { path: "m/1.sql", text: 'create table notes (id int); create table "Old" (id int);' },
        {
          path: "m/2.sql",
          text: 'alter table public.notes enable row level security; drop table "Old";',
        },
      ]),
    ).toEqual([]);
  });

  test("switching it off again is caught", () => {
    expect(
      findUnprotectedTables([
        {
          path: "m/1.sql",
          text: "create table a (id int); alter table a enable row level security;",
        },
        { path: "m/2.sql", text: "alter table a disable row level security;" },
      ]),
    ).toHaveLength(1);
  });

  test("private schemas, temp tables and comments are ignored", () => {
    expect(
      findUnprotectedTables([
        {
          path: "m/1.sql",
          text: "create table private.a (id int);\ncreate temp table b (id int);\n-- create table c (id int);\n/* create table d (id int); */",
        },
      ]),
    ).toEqual([]);
  });

  test("a table whose name starts with temp is still checked", () => {
    expect(
      findUnprotectedTables([{ path: "m.sql", text: "create table template (id int);" }]),
    ).toHaveLength(1);
  });

  test("only tools using Supabase are in scope", () => {
    expect(usesSupabase({ "@supabase/supabase-js": "2" }, [])).toBe(true);
    expect(usesSupabase({}, ["supabase"])).toBe(true);
    expect(usesSupabase({ pg: "8" }, ["db"])).toBe(false);
  });
});

describe("secrets and credentials", () => {
  test("a Gitleaks finding keeps its location and drops the secret", () => {
    const leaks = parseLeaks([
      {
        RuleID: "github-pat",
        File: "config.js",
        StartLine: 3,
        Commit: "abcdef1234567890",
        Fingerprint: "abcdef:config.js:github-pat:3",
        Secret: "the-actual-secret",
        Match: "token: the-actual-secret",
        Email: "person@example.com",
      },
    ]);
    expect(leaks[0]?.file).toBe("config.js");
    expect(JSON.stringify(leaks)).not.toContain("the-actual-secret");
    expect(JSON.stringify(leaks)).not.toContain("person@example.com");
  });

  test("a tool's commands never receive the pipeline's credentials", () => {
    const clean = safeEnv({
      PATH: "/usr/bin",
      CI: "true",
      GITHUB_TOKEN: "x",
      SRE_AGENT_GITHUB_TOKEN: "x",
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_FOUNDRY_API_KEY: "x",
      TEAMS_WEBHOOK_URL: "x",
      AZURE_CLIENT_ID: "x",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "x",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic x",
      DATABASE_URL: "postgres://x",
    });
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.CI).toBe("true");
    for (const name of Object.keys(clean)) {
      if (name !== "AZURE_CONFIG_DIR") expect(isSensitive(name)).toBe(false);
    }
    expect(clean.AZURE_CONFIG_DIR).toBeDefined();
    expect(clean.GITHUB_TOKEN).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
  });
});

describe("the files every tool receives", () => {
  test("the workflow pins the platform's exact release", () => {
    const text = workflowFile(manifest, settings, "1.4.0", "main");
    expect(text).toContain("uses: acme/ci-cd-temp/actions/checks@v1.4.0");
    expect(text).toContain("uses: acme/ci-cd-temp/actions/guardrails@v1.4.0");
    expect(text).toContain("uses: acme/ci-cd-temp/actions/deploy@v1.4.0");
    expect(text).not.toMatch(/__[A-Z_]+__/);
    expect(text).toContain("name: Checks");
    expect(text).toContain("name: Guardrails");
    expect(text).toContain("environment: production");
  });

  test("code scanning is only added for languages it's set up for", () => {
    expect(workflowFile(manifest, settings, "1.0.0", "main")).toContain("code-scanning:");
    const other = workflowFile({ ...manifest, stack: "unknown" }, settings, "1.0.0", "main");
    expect(other).not.toContain("code-scanning:");
    expect(other).toContain("name: Build image");
  });

  test("every pull request goes to the Pipeline approvers", () => {
    expect(codeOwnersFile(settings)).toContain("* @acme/pipeline-approvers");
  });

  test("a team's own agent instructions are kept, and the platform's refreshed", () => {
    const once = mergeManagedBlock("# Our notes\n", "Rule one");
    expect(once).toContain("# Our notes");
    expect(once).toContain("Rule one");
    const twice = mergeManagedBlock(once, "Rule two");
    expect(twice).toContain("# Our notes");
    expect(twice).toContain("Rule two");
    expect(twice).not.toContain("Rule one");
  });

  test("merging agent settings never turns a denied action back on", () => {
    const merged = mergeClaudeSettings(
      { permissions: { allow: ["Bash(git push *)", "Bash(ls)"] } },
      { permissions: { deny: ["Bash(git push *)"], ask: ["Edit(x)"] } },
    );
    expect(merged.permissions?.deny).toContain("Bash(git push *)");
    expect(merged.permissions?.allow).toEqual(["Bash(ls)"]);
  });

  test("the generated image builds, drops dev packages and doesn't run as root", () => {
    const text = dockerfileFor(manifest) ?? "";
    expect(text).toContain("FROM node:22-slim AS build");
    expect(text).toContain("RUN npm ci\n");
    expect(text).toContain("RUN npm run build");
    expect(text).toContain("RUN npm prune --omit=dev");
    expect(text).toContain("USER node");
    expect(text).toContain("EXPOSE 3000");
    expect(text).not.toMatch(/__[A-Z_]+__/);
  });

  test("a browser-only tool gets a static image", () => {
    const text = dockerfileFor({ ...manifest, start: null }) ?? "";
    expect(text).toContain("nginx-unprivileged");
    expect(text).toContain("COPY --from=build /app/dist /usr/share/nginx/html");
  });

  test("a tool's Azure parameters follow one convention", () => {
    const entry = newRegistryEntry({
      name: "notes-tool",
      kind: "migrated",
      owner: "sam@example.com",
      org: "acme",
      dataClassification: "Confidential",
    });
    expect(entry.repo).toBe("acme/notes-tool");
    expect(entry.resourceGroup).toBe("rg-notes-tool");
    const text = bicepParamFile(entry, manifest, settings);
    expect(text).toContain("param name = 'notes-tool'");
    expect(text).toContain("param targetPort = 3000");
    expect(text).toContain("param dataClassification = 'Confidential'");
  });
});

describe("the deploy stage", () => {
  const state = {
    fqdn: "notes.lemon-1.australiaeast.azurecontainerapps.io",
    latestReady: "notes--new",
    traffic: [
      { revisionName: "notes--old", weight: 100, label: "previous" },
      { revisionName: "notes--new", weight: 0, label: "staging" },
    ],
  };

  test("a staging revision gets its own address", () => {
    expect(labelUrl(state.fqdn, "staging")).toBe(
      "https://notes---staging.lemon-1.australiaeast.azurecontainerapps.io",
    );
  });

  test("the live revision is the one with the traffic, not the newest", () => {
    expect(liveRevision(state)).toBe("notes--old");
    expect(liveRevision({ ...state, traffic: [{ weight: 100, latestRevision: true }] })).toBe(
      "notes--new",
    );
  });

  test("a release only counts as healthy when Azure says so", () => {
    expect(revisionVerdict({ health: "Healthy", provisioning: "Provisioned" })).toBe(true);
    expect(revisionVerdict({ health: "None", running: "Activating" })).toBe(false);
    expect(() => revisionVerdict({ provisioning: "Failed" })).toThrow();
    expect(() => revisionVerdict({ running: "Failed" })).toThrow();
  });

  test("only Pipeline approvers can release", () => {
    expect(canRelease("maintain")).toBe(true);
    expect(canRelease("admin")).toBe(true);
    expect(canRelease("write")).toBe(false);
    expect(canRelease("read")).toBe(false);
    expect(canRelease(undefined)).toBe(false);
  });

  test("an environment only counts as a gate if it really has required reviewers", () => {
    expect(hasRequiredReviewers({ protection_rules: [{ type: "required_reviewers" }] })).toBe(true);
    expect(hasRequiredReviewers({ protection_rules: [{ type: "branch_policy" }] })).toBe(false);
    expect(hasRequiredReviewers({})).toBe(false);
  });

  test("production never follows staging automatically without a real gate", () => {
    const text = workflowFile(manifest, settings, "1.0.0", "main");
    const job = text.slice(text.indexOf("  production:"), text.indexOf("  promote:"));
    expect(job).toContain("if: vars.PRODUCTION_GATE == 'environment'");
    expect(job).toContain("gate: ${{ vars.PRODUCTION_GATE }}");
    expect(text).toContain("options: [deploy, promote, rollback]");
  });

  test("rolling back finds the previous revision", () => {
    expect(labelledRevision(state, "previous")).toBe("notes--old");
  });

  test("revision names are valid and a re-run gets a new one", () => {
    expect(revisionSuffix("ABCDEF1234", 2)).toBe("rabcdef1-2");
  });

  test("a sign-in redirect counts as answering, and a server error doesn't", () => {
    expect(answering(200)).toBe(true);
    expect(answering(302)).toBe(true);
    expect(answering(401)).toBe(true);
    expect(answering(500)).toBe(false);
    expect(answering(503)).toBe(false);
  });

  test("releases aren't reported as drift, and real changes are", () => {
    const items = parseWhatIf("notes", {
      changes: [
        {
          resourceId: "/x/containerApps/notes",
          changeType: "Modify",
          delta: [
            {
              path: "properties.template.containers.0.image",
              propertyChangeType: "Modify",
              before: "a",
              after: "b",
            },
            {
              path: "properties.configuration.ingress.traffic",
              propertyChangeType: "Modify",
              before: 1,
              after: 2,
            },
            {
              path: "properties.template.scale.minReplicas",
              propertyChangeType: "Modify",
              before: 1,
              after: 0,
            },
          ],
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.details).toHaveLength(1);
    expect(items[0]?.details[0]).toContain("minReplicas");
  });

  test("the Bicep template lets a release be tested with no traffic", () => {
    expect(readFileSync("infra/tool.bicep", "utf8")).toContain("activeRevisionsMode: 'Multiple'");
  });
});

describe("the afternoon report covers both kinds of tool", () => {
  const tools = [
    {
      name: "fresh",
      owner: "a@example.com",
      resourceGroup: "rg-fresh",
      parameters: "p",
      kind: "new" as const,
      repo: "acme/fresh",
    },
    {
      name: "moved",
      owner: "b@example.com",
      resourceGroup: "rg-moved",
      parameters: "p",
      kind: "migrated" as const,
      repo: "acme/moved",
    },
  ];
  const config = {
    title: "Platform report",
    timeZone: "Australia/Brisbane",
    tools,
    foundry: { model: "claude-opus-5-5", auth: "key" as const },
  };

  test("reads what's outstanding from a tool's baseline", () => {
    const item = parseAdoption(tools[1]!, {
      checks: {
        lint: { status: "failing", problems: 4 },
        test: { status: "missing", problems: null },
        data: { status: "failing", problems: 1, serious: true },
      },
    });
    expect(item).toEqual({ tool: "moved", kind: "migrated", serious: 1, known: 2 });
    expect(parseAdoption(tools[0]!, null)).toEqual({
      tool: "fresh",
      kind: "new",
      serious: 0,
      known: 0,
    });
  });

  test("searches every registered repository for what shipped", () => {
    expect(repoQuery(tools)).toBe("repo:acme/fresh repo:acme/moved");
  });

  test("a serious issue is a decision, and known issues show by tool", () => {
    const facts = emptyFacts(config, new Date("2026-11-23T05:00:00Z"));
    facts.adoption = [
      { tool: "moved", kind: "migrated", serious: 1, known: 2 },
      { tool: "fresh", kind: "new", serious: 0, known: 0 },
    ];
    expect(decisions(facts)[0]).toContain("moved: 1 serious issue");
    const text = renderPlain(facts);
    expect(text).toContain("moved (b@example.com, migrated)");
    expect(text).toContain("3 known issues to work down");
    expect(text).toContain("fresh (a@example.com): no drift · no alerts");
  });
});
