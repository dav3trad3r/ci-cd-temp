// The environment for running a tool's own commands. Those commands can include code an AI agent
// just wrote, or a dependency's install script, so they never get the pipeline's credentials.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SENSITIVE =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|WEBHOOK|DATABASE_URL|CONNECTION_?STRING|^AZURE_|^ARM_|^ANTHROPIC|^OPENAI|^GIT_CONFIG|^SSH_AUTH|^ACTIONS_ID_TOKEN/i;

export function isSensitive(name: string): boolean {
  return SENSITIVE.test(name);
}

export function safeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isSensitive(name)) clean[name] = value;
  }
  // Plain output, so problem counts can be read from it.
  clean.NO_COLOR = "1";
  clean.FORCE_COLOR = "0";
  // An empty Azure profile, so a signed-in `az` session can't be used from inside a test.
  clean.AZURE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "platform-no-azure-"));
  return clean;
}
