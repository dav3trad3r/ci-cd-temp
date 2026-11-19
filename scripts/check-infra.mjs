// Infrastructure check: lints and compiles every Bicep template and parameter file in
// infra/, so a broken template is caught in the pull request, not at deploy time.
// Needs the Azure CLI. Locally it skips with a note if the CLI isn't installed; CI
// (where the CLI is preinstalled) always runs it.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const BICEP_VERSION = "v0.49.2";
const windows = process.platform === "win32";

function az(...args) {
  // On Windows the CLI is az.cmd, which Node can only start through a shell.
  return execFileSync(windows ? "az.cmd" : "az", args, {
    encoding: "utf8",
    shell: windows,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  az("version");
} catch {
  if (process.env.CI) {
    console.error("The Azure CLI is needed for the infrastructure check.");
    process.exit(1);
  }
  console.log("Infrastructure: Azure CLI not found, skipping (CI runs this check).");
  process.exit(0);
}

if (process.env.CI) az("bicep", "install", "--version", BICEP_VERSION);

function files(dir, ext) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, ext);
    return entry.name.endsWith(ext) ? [path] : [];
  });
}

const problems = [];
const templates = files("infra", ".bicep");
const params = files("infra", ".bicepparam");

for (const file of templates) {
  try {
    az("bicep", "lint", "--file", file);
    az("bicep", "build", "--file", file, "--stdout");
  } catch (error) {
    problems.push(`${file}:\n${error.stderr || error.message}`);
  }
}
for (const file of params) {
  try {
    az("bicep", "build-params", "--file", file, "--stdout");
  } catch (error) {
    problems.push(`${file}:\n${error.stderr || error.message}`);
  }
}

if (problems.length) {
  console.error(`Infrastructure check failed:\n\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(
  `✓ Infrastructure: ${templates.length} templates and ${params.length} parameter files lint and compile.`,
);
