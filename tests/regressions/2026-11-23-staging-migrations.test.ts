// 2026-11-23: A staging revision uses the production database, and the starter app ran its
// migrations when it booted. A schema change therefore reached production before anyone approved
// it, even if that revision then failed its health check. Migrations now run once, as a release
// step after approval and before traffic moves, and a failed one leaves traffic where it was.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyMigrations, inMemoryDb, onBoot, pendingMigrations } from "../../src/lib/db.js";
import { detectStack, migratesAtStartup, type RepoFacts } from "../../scripts/platform/detect.js";
import { migrationJobName, promote, rollback } from "../../scripts/platform/deploy.js";
import { manifestSchema, newRegistryEntry } from "../../scripts/platform/model.js";
import { applyToolFiles, bicepParamFile } from "../../scripts/platform/tool-files.js";

const azure = vi.hoisted(() => ({
  calls: [] as string[][],
  answer: (() => null) as (args: string[]) => unknown,
}));

vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  const real = await original<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (_command: string, args: string[]) => {
      azure.calls.push(args);
      const answer = azure.answer(args);
      if (answer instanceof Error) throw answer;
      return { stdout: answer === null ? "" : JSON.stringify(answer), stderr: "" };
    },
  });
  return { ...real, execFile };
});

const manifest = manifestSchema.parse({
  name: "notes-tool",
  kind: "new",
  owner: "sam@example.com",
  stack: "node",
  nodeVersion: "22",
  packageManager: "npm",
  commands: {
    install: "npm ci",
    format: null,
    lint: null,
    typecheck: null,
    test: null,
    build: null,
    smoke: null,
    eval: null,
  },
  webDir: null,
  start: "npm start",
  migrate: "npm run db:migrate",
  port: 8080,
  healthPath: "/healthz",
  dockerfile: ".platform/Dockerfile",
});

const target = { app: "notes-tool", group: "rg-notes-tool" };
const liveApp = {
  properties: {
    latestReadyRevisionName: "notes-tool--new",
    configuration: {
      ingress: {
        fqdn: "notes-tool.lemon-1.australiaeast.azurecontainerapps.io",
        traffic: [
          { revisionName: "notes-tool--old", weight: 100 },
          { revisionName: "notes-tool--new", weight: 0, label: "staging" },
        ],
      },
    },
  },
};

function fakeAzure({
  job = true,
  status = "Succeeded",
  command = ["sh", "-c", "npm run db:migrate"],
} = {}) {
  azure.answer = (args) => {
    const line = args.join(" ");
    if (line.startsWith("containerapp show")) return liveApp;
    if (line.startsWith("containerapp job show")) {
      return job
        ? { properties: { template: { containers: [{ name: "migrate", command }] } } }
        : new Error("not found");
    }
    if (line.startsWith("containerapp revision show")) return "acr.azurecr.io/notes-tool:abc1234";
    if (line.startsWith("containerapp job start")) return { name: "notes-tool-migrate-run1" };
    if (line.startsWith("containerapp job execution show")) return status;
    return null;
  };
}

const firstCall = (prefix: string) =>
  azure.calls.findIndex((args) => args.join(" ").startsWith(prefix));
const MOVE_TRAFFIC = "containerapp ingress traffic set";

describe("a release changes the database only after approval", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_ACTIONS", "false"); // the release check calls GitHub only in Actions
    azure.calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("promote migrates with the approved image, then moves traffic", async () => {
    fakeAzure();
    await promote(target, manifest, "notes-tool--new");
    const update = azure.calls[firstCall("containerapp job update")] ?? [];
    expect(update).toContain("acr.azurecr.io/notes-tool:abc1234");
    expect(firstCall("containerapp job update")).toBeLessThan(firstCall("containerapp job start"));
    expect(firstCall("containerapp job start")).toBeLessThan(firstCall(MOVE_TRAFFIC));
  });

  test.each(["Failed", "Stopped", "Degraded"])(
    "a migration that ends as %s leaves traffic where it was",
    async (status) => {
      fakeAzure({ status });
      await expect(promote(target, manifest, "notes-tool--new")).rejects.toThrow(status);
      expect(firstCall(MOVE_TRAFFIC)).toBe(-1);
      expect(firstCall("containerapp revision label")).toBe(-1);
    },
  );

  test("a tool with a migrate command can't release without its job", async () => {
    fakeAzure({ job: false });
    await expect(promote(target, manifest, "notes-tool--new")).rejects.toThrow("Bicep");
    expect(firstCall(MOVE_TRAFFIC)).toBe(-1);
  });

  test("a job running a different command stops the release", async () => {
    fakeAzure({ command: ["sh", "-c", "npm run something-else"] });
    await expect(promote(target, manifest, "notes-tool--new")).rejects.toThrow("Bicep");
    expect(firstCall("containerapp job start")).toBe(-1);
    expect(firstCall(MOVE_TRAFFIC)).toBe(-1);
  });

  test("a tool with no migrate command releases without a job", async () => {
    fakeAzure();
    await promote(target, { ...manifest, migrate: null }, "notes-tool--new");
    expect(firstCall("containerapp job")).toBe(-1);
    expect(firstCall(MOVE_TRAFFIC)).toBeGreaterThanOrEqual(0);
  });

  test("rollback never runs a migration", async () => {
    fakeAzure();
    azure.answer = ((inner) => (args: string[]) => {
      if (args.join(" ").startsWith("containerapp show")) {
        return {
          properties: {
            ...liveApp.properties,
            configuration: {
              ingress: {
                fqdn: liveApp.properties.configuration.ingress.fqdn,
                traffic: [
                  { revisionName: "notes-tool--new", weight: 100 },
                  { revisionName: "notes-tool--old", weight: 0, label: "previous" },
                ],
              },
            },
          },
        };
      }
      return inner(args);
    })(azure.answer);
    await rollback(target, manifest);
    expect(firstCall("containerapp job")).toBe(-1);
    expect(firstCall(MOVE_TRAFFIC)).toBeGreaterThanOrEqual(0);
  });

  test("job names fit Azure's limit and match the Bicep template", () => {
    expect(migrationJobName("notes-tool")).toBe("notes-tool-migrate");
    const longest = migrationJobName("a".repeat(32));
    expect(longest.length).toBeLessThanOrEqual(32);
    expect(migrationJobName(`${"a".repeat(23)}-tool`)).toBe(`${"a".repeat(23)}-migrate`);
    expect(readFileSync("infra/tool.bicep", "utf8")).toContain(
      "replace('${take(name, 24)}-migrate', '--migrate', '-migrate')",
    );
  });
});

describe("the database at boot", () => {
  let dir: string;
  const url = () => pathToFileURL(`${dir}/`);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrations-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const table = async (db: Awaited<ReturnType<typeof inMemoryDb>>, name: string) =>
    (await db.query<{ t: string | null }>("select to_regclass($1)::text as t", [name])).rows[0]?.t;

  test("a production boot changes nothing and says what's waiting", async () => {
    const db = await inMemoryDb();
    const { applied, waiting } = await onBoot(db, true);
    expect(applied).toEqual([]);
    expect(waiting).toContain("001_items.sql");
    expect(await table(db, "items")).toBeNull();
    expect(await table(db, "_migrations")).toBeNull();
  });

  test("a local boot still sets up its own database", async () => {
    const db = await inMemoryDb();
    const { applied, waiting } = await onBoot(db, false);
    expect(applied).toContain("001_items.sql");
    expect(waiting).toEqual([]);
    expect(await pendingMigrations(db)).toEqual([]);
  });

  test("a migration that fails halfway leaves nothing behind, and can run again", async () => {
    writeFileSync(join(dir, "001_ok.sql"), "create table first_table (id int);");
    writeFileSync(join(dir, "002_bad.sql"), "create table half_done (id int); select 1 / 0;");
    const db = await inMemoryDb();
    await expect(applyMigrations(db, url())).rejects.toThrow();
    expect(await table(db, "first_table")).toBe("first_table");
    expect(await table(db, "half_done")).toBeNull();
    expect(await pendingMigrations(db, url())).toEqual(["002_bad.sql"]);

    writeFileSync(join(dir, "002_bad.sql"), "create table half_done (id int);");
    expect(await applyMigrations(db, url())).toEqual(["002_bad.sql"]);
    expect(await table(db, "half_done")).toBe("half_done");
  });
});

describe("spotting a tool that changes its database when it starts", () => {
  type Facts = Omit<RepoFacts, "files">;
  const facts = (extra: Facts): RepoFacts => ({ files: [], ...extra });

  test.each<Facts>([
    { packageJson: { scripts: { start: "prisma migrate deploy && node server.js" } } },
    { packageJson: { scripts: { prestart: "npm run db:migrate", start: "node server.js" } } },
    { packageJson: { scripts: { start: "drizzle-kit push && node dist/index.js" } } },
    { dockerfile: 'FROM node:22\nCMD ["sh", "-c", "npx knex migrate:latest && node ."]' },
    { sourceFiles: ["await knex.migrate.latest();"] },
    { sourceFiles: ["new DataSource({ type: 'postgres', synchronize: true })"] },
    { sourceFiles: ["await sequelize.sync({ alter: true });"] },
    { sourceFiles: ['import { migrate } from "drizzle-orm/node-postgres/migrator";'] },
  ])("flags %j", (extra) => {
    expect(migratesAtStartup(facts(extra))).toBe(true);
  });

  test.each<Facts>([
    { packageJson: { scripts: { start: "node server.js", "db:migrate": "knex migrate:latest" } } },
    { dockerfile: "FROM node:22\nRUN npx prisma generate\nCMD node server.js" },
    { sourceFiles: ["export const synchronize = false;"] },
  ])("doesn't flag %j", (extra) => {
    expect(migratesAtStartup(facts(extra))).toBe(false);
  });

  test("the result reaches the manifest, and never turns on a migrate command by itself", () => {
    const detected = detectStack({
      files: ["package.json"],
      packageJson: {
        scripts: { start: "npm run migrate && node .", migrate: "knex migrate:latest" },
      },
    });
    expect(detected.migratesAtStartup).toBe(true);
    expect(detected.migrate).toBeNull();
  });

  test("onboarding tells a person, and the Azure parameters carry the command", () => {
    const work = mkdtempSync(join(tmpdir(), "flagged-tool-"));
    const settings = {
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
    try {
      const { notes } = applyToolFiles(
        work,
        { ...manifest, migratesAtStartup: true },
        settings,
        "1.1.0",
        "main",
      );
      expect(notes.join(" ")).toContain("before approval");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    const entry = newRegistryEntry({
      name: "notes-tool",
      kind: "new",
      owner: "sam@example.com",
      org: "acme",
    });
    expect(bicepParamFile(entry, manifest, settings)).toContain(
      "param migrateCommand = 'npm run db:migrate'\n",
    );
    expect(bicepParamFile(entry, { ...manifest, migrate: null }, settings)).not.toContain(
      "migrateCommand",
    );
  });
});
