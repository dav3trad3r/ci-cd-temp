// What the platform knows about each tool. Three files, one job each:
// - ops/platform.json       this organisation's settings (GitHub org, approvers team, Azure)
// - ops/tools/<name>.json   the tool register: who owns it and where it runs. The SRE agent and
//                           the afternoon report both read it, so a registered tool gets both.
// - .platform/tool.json     in each tool's repository: how that tool installs, tests and builds.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The root of the platform repository, wherever these scripts are running from. */
export const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the settings and the tool register live. Only the self-test points it elsewhere. */
export const DATA_ROOT = resolve(process.env.PLATFORM_DATA_ROOT ?? PLATFORM_ROOT);

export const MANIFEST_PATH = ".platform/tool.json";
export const BASELINE_PATH = ".platform/baseline.json";

const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/, "use lower-case letters, digits and hyphens");
const kind = z.enum(["new", "migrated"]);
const command = z.string().min(1).nullable();

export const commandsSchema = z.object({
  install: command,
  format: command,
  lint: command,
  typecheck: command,
  test: command,
  build: command,
  smoke: command,
  /** AI evaluation. Can cost money, so it runs nightly rather than on every pull request. */
  eval: command,
});
export type Commands = z.infer<typeof commandsSchema>;

export const manifestSchema = z.object({
  name: toolName,
  kind,
  owner: z.email(),
  stack: z.enum(["node", "unknown"]),
  nodeVersion: z.string().regex(/^\d+(\.\d+){0,2}$/),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).nullable(),
  commands: commandsSchema,
  /** The folder of files sent to the browser after a build, if the tool has one. */
  webDir: z.string().nullable(),
  /** The command that starts the built tool. */
  start: z.string().nullable(),
  /** Updates the tool's database. Runs once per release, after approval and before traffic moves. */
  migrate: command.default(null),
  /** The tool changes its database when it boots, which reaches production before approval. */
  migratesAtStartup: z.boolean().default(false),
  port: z.number().int().min(1).max(65535),
  healthPath: z.string().startsWith("/"),
  /** Dockerfile used to build the image. Null until the tool can be containerised. */
  dockerfile: z.string().nullable(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const registrySchema = z.object({
  name: toolName,
  kind,
  owner: z.email(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  baseBranch: z.string().min(1),
  resourceGroup: z.string().min(1),
  containerApp: z.string().min(1),
  /** The tool's Azure parameters file, used for the drift check. */
  parameters: z.string().min(1),
  dataClassification: z.enum(["Public", "Internal", "Confidential", "Restricted"]),
  dailyBudget: z.number().positive().optional(),
  githubReviewer: z.string().optional(),
  logAnalyticsWorkspaceId: z.string().optional(),
  /** Where a migrated tool came from. */
  source: z.string().optional(),
});
export type RegistryEntry = z.infer<typeof registrySchema>;

export const settingsSchema = z.object({
  org: z.string().min(1),
  platformRepo: z.string().min(1),
  approversTeam: z.string().min(1),
  azure: z.object({
    environmentId: z.string().min(1),
    actionGroupId: z.string().min(1),
    registryName: z.string().min(1),
    registryResourceGroup: z.string().min(1),
    costCentre: z.string().min(1),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadSettings(root = DATA_ROOT): Settings {
  return settingsSchema.parse(readJson(join(root, "ops/platform.json")));
}

export function saveSettings(settings: Settings, root = DATA_ROOT) {
  writeJson(join(root, "ops/platform.json"), settingsSchema.parse(settings));
}

/** The platform's release, which is the version each tool pins. */
export function platformVersion(root = PLATFORM_ROOT): string {
  return (readJson(join(root, "package.json")) as { version: string }).version;
}

export function loadManifest(dir: string): Manifest {
  return manifestSchema.parse(readJson(join(dir, MANIFEST_PATH)));
}

export function saveManifest(dir: string, manifest: Manifest) {
  writeJson(join(dir, MANIFEST_PATH), manifestSchema.parse(manifest));
}

export function hasManifest(dir: string): boolean {
  return existsSync(join(dir, MANIFEST_PATH));
}

export function loadRegistry(root = DATA_ROOT): RegistryEntry[] {
  const dir = join(root, "ops/tools");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => registrySchema.parse(readJson(join(dir, file))));
}

export function saveRegistryEntry(entry: RegistryEntry, root = DATA_ROOT) {
  writeJson(join(root, "ops/tools", `${entry.name}.json`), registrySchema.parse(entry));
}

/** The register entry a new or migrated tool starts with. Azure names follow one convention. */
export function newRegistryEntry(input: {
  name: string;
  kind: "new" | "migrated";
  owner: string;
  org: string;
  baseBranch?: string;
  dataClassification?: RegistryEntry["dataClassification"];
  dailyBudget?: number;
  source?: string;
}): RegistryEntry {
  return registrySchema.parse({
    name: input.name,
    kind: input.kind,
    owner: input.owner,
    repo: `${input.org}/${input.name}`,
    baseBranch: input.baseBranch ?? "main",
    resourceGroup: `rg-${input.name}`,
    containerApp: input.name,
    parameters: `infra/tools/${input.name}.bicepparam`,
    dataClassification: input.dataClassification ?? "Internal",
    ...(input.dailyBudget ? { dailyBudget: input.dailyBudget } : {}),
    ...(input.source ? { source: input.source } : {}),
  });
}
