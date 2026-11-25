// The files every tool gets from the platform, whether it's new or migrated. Writing them never
// touches the tool's application code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GENERATED_DOCKERFILE } from "./detect.js";
import { PLATFORM_ROOT, type Manifest, type RegistryEntry, type Settings } from "./model.js";

const source = (file: string) => readFileSync(join(PLATFORM_ROOT, "platform/files", file), "utf8");

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/__([A-Z_]+)__/g, (whole, key: string) => values[key] ?? whole);
}

export function workflowFile(
  manifest: Manifest,
  settings: Settings,
  version: string,
  baseBranch: string,
): string {
  const template =
    manifest.stack === "node"
      ? source("platform.yml").replace(/^ *# codeql:(start|end)\n/gm, "")
      : source("platform.yml").replace(/ *# codeql:start\n[\s\S]*? *# codeql:end\n/, "");
  return fill(template, {
    ORG: settings.org,
    PLATFORM_REPO: settings.platformRepo,
    VERSION: version,
    BASE_BRANCH: baseBranch,
    REGISTRY: settings.azure.registryName,
  });
}

export function dependabotFile(manifest: Manifest, settings: Settings): string {
  const text = fill(source("dependabot.yml"), {
    ORG: settings.org,
    PLATFORM_REPO: settings.platformRepo,
  });
  // Only JavaScript tools have npm updates to receive.
  return manifest.stack === "node"
    ? text
    : text.replace(/ {2}- package-ecosystem: npm[\s\S]*$/, "");
}

export function codeOwnersFile(settings: Settings): string {
  return [
    "# Managed by the platform. Every pull request needs a Pipeline approver.",
    `* @${settings.org}/${settings.approversTeam}`,
    "",
  ].join("\n");
}

const START = "<!-- platform:start -->";
const END = "<!-- platform:end -->";

/** Adds or refreshes the platform's section, and keeps everything the tool's team wrote. */
export function mergeManagedBlock(existing: string | undefined, block: string): string {
  const managed = `${START}\n\n${block.trim()}\n\n${END}\n`;
  if (!existing?.trim()) return managed;
  const from = existing.indexOf(START);
  const to = existing.indexOf(END);
  if (from >= 0 && to > from) {
    return `${existing.slice(0, from)}${managed.trimEnd()}${existing.slice(to + END.length)}`;
  }
  return `${existing.trimEnd()}\n\n${managed}`;
}

interface ClaudeSettings {
  $schema?: string;
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  [key: string]: unknown;
}

/** The platform's rules are added to the tool's. Nothing already denied becomes allowed. */
export function mergeClaudeSettings(
  existing: ClaudeSettings | undefined,
  platform: ClaudeSettings,
): ClaudeSettings {
  const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];
  const deny = union(existing?.permissions?.deny, platform.permissions?.deny);
  const ask = union(existing?.permissions?.ask, platform.permissions?.ask).filter(
    (rule) => !deny.includes(rule),
  );
  const allow = union(existing?.permissions?.allow, platform.permissions?.allow).filter(
    (rule) => !deny.includes(rule) && !ask.includes(rule),
  );
  return { ...platform, ...existing, permissions: { ...existing?.permissions, allow, ask, deny } };
}

const BASE_IMAGES: Record<string, string> = { bun: "oven/bun:1-slim" };

export function dockerfileFor(manifest: Manifest): string | undefined {
  if (manifest.dockerfile !== GENERATED_DOCKERFILE || !manifest.commands.install) return undefined;
  const pm = manifest.packageManager ?? "npm";
  const prune: Record<string, string> = {
    npm: "RUN npm prune --omit=dev",
    pnpm: "RUN pnpm prune --prod",
  };
  const install = manifest.commands.install.replace(/ --no-audit --no-fund/, "");
  const values = {
    BASE_IMAGE: BASE_IMAGES[pm] ?? `node:${manifest.nodeVersion}-slim`,
    SETUP: pm === "pnpm" || pm === "yarn" ? "RUN corepack enable\n" : "",
    INSTALL: install,
    BUILD: manifest.commands.build ? `RUN ${manifest.commands.build}` : "",
    PRUNE: prune[pm] ?? "",
    PORT: String(manifest.port),
    USER: pm === "bun" ? "bun" : "node",
    // Docker's exec form is a JSON array, so JSON writes it correctly whatever the command holds.
    CMD: JSON.stringify(["sh", "-c", manifest.start ?? ""]),
    WEB_DIR: manifest.webDir ?? "",
  };
  const text = fill(source(manifest.start ? "Dockerfile.node" : "Dockerfile.static"), values);
  return `${text.replace(/\n{3,}/g, "\n\n").replace(/\n+FROM/g, "\n\nFROM")}`;
}

const BICEP_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "'": "\\'",
  "${": "\\${",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** A Bicep string holding exactly this text. `${` would otherwise be read as code. */
function bicepString(value: string): string {
  return `'${value.replace(/[\\'\n\r\t]|\$\{/g, (match) => BICEP_ESCAPES[match] ?? match)}'`;
}

export function bicepParamFile(
  entry: RegistryEntry,
  manifest: Manifest,
  settings: Settings,
): string {
  const quote = bicepString;
  const secrets =
    manifest.kind === "new"
      ? [
          "param secrets = [",
          "  { name: 'app-jwt-secret', env: 'APP_JWT_SECRET' }",
          "  { name: 'database-url', env: 'DATABASE_URL' }",
          "]",
        ]
      : [
          "// Add the settings this tool needs. Values live in its Key Vault, never here.",
          "param secrets = []",
        ];
  return [
    `// ${entry.name}: generated by the platform (${entry.kind} tool).`,
    "using '../tool.bicep'",
    "",
    `param name = ${quote(entry.name)}`,
    `param owner = ${quote(entry.owner)}`,
    `param costCentre = ${quote(settings.azure.costCentre)}`,
    `param dataClassification = ${quote(entry.dataClassification)}`,
    "",
    `param environmentId = ${quote(settings.azure.environmentId)}`,
    `param actionGroupId = ${quote(settings.azure.actionGroupId)}`,
    `param registryName = ${quote(settings.azure.registryName)}`,
    `param registryResourceGroup = ${quote(settings.azure.registryResourceGroup)}`,
    "",
    `param targetPort = ${manifest.port}`,
    `param healthPath = ${quote(manifest.healthPath)}`,
    ...(manifest.migrate ? [`param migrateCommand = ${quote(manifest.migrate)}`] : []),
    "",
    "// This tool's own deploy identities: its pipeline can't reach any other tool.",
    `param githubRepo = ${quote(entry.repo)}`,
    `param deployBranch = ${quote(entry.baseBranch)}`,
    "",
    "// The tool's Entra app registration. Replace this placeholder before the first deployment.",
    "param signInClientId = '00000000-0000-0000-0000-000000000000'",
    "",
    ...secrets,
    "",
  ].join("\n");
}

function write(dir: string, path: string, content: string) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const read = (dir: string, path: string) => {
  const target = join(dir, path);
  return existsSync(target) ? readFileSync(target, "utf8") : undefined;
};

export interface ApplyResult {
  written: string[];
  /** Existing files a person should look at. */
  notes: string[];
}

/** Writes or refreshes every platform-managed file in a tool's repository. */
export function applyToolFiles(
  dir: string,
  manifest: Manifest,
  settings: Settings,
  version: string,
  baseBranch: string,
): ApplyResult {
  const written: string[] = [];
  const notes: string[] = [];
  const put = (path: string, content: string) => {
    if (read(dir, path) === content) return;
    write(dir, path, content);
    written.push(path);
  };

  put(".github/workflows/platform.yml", workflowFile(manifest, settings, version, baseBranch));
  put(".github/CODEOWNERS", codeOwnersFile(settings));

  const dependabot = read(dir, ".github/dependabot.yml");
  if (dependabot && !dependabot.includes("Managed by the platform")) {
    notes.push(
      ".github/dependabot.yml already exists and was kept. Add the github-actions update so platform releases arrive.",
    );
  } else {
    put(".github/dependabot.yml", dependabotFile(manifest, settings));
  }

  put("AGENTS.md", mergeManagedBlock(read(dir, "AGENTS.md"), source("agents-rules.md")));
  put(
    "CLAUDE.md",
    mergeManagedBlock(
      read(dir, "CLAUDE.md"),
      "@AGENTS.md\n\n`.claude/settings.json` enforces part of these rules.",
    ),
  );

  const platformSettings = JSON.parse(
    readFileSync(join(PLATFORM_ROOT, ".claude/settings.json"), "utf8"),
  ) as ClaudeSettings;
  const existingSettings = read(dir, ".claude/settings.json");
  put(
    ".claude/settings.json",
    `${JSON.stringify(
      mergeClaudeSettings(
        existingSettings ? (JSON.parse(existingSettings) as ClaudeSettings) : undefined,
        platformSettings,
      ),
      null,
      2,
    )}\n`,
  );

  const dockerfile = dockerfileFor(manifest);
  if (dockerfile) {
    put(GENERATED_DOCKERFILE, dockerfile);
    put(`${GENERATED_DOCKERFILE}.dockerignore`, source("Dockerfile.dockerignore"));
  } else if (!manifest.dockerfile) {
    notes.push("No way to build an image was found, so this tool can't deploy yet.");
  }

  if (manifest.migratesAtStartup) {
    notes.push(
      'This tool looks like it changes its database when it starts. Staging shares the production database, so that change would land before approval. Move it into a command, set "migrate" in .platform/tool.json, set "migratesAtStartup" to false, and add migrateCommand to its Azure parameters.',
    );
  }

  return { written, notes };
}
