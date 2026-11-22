// One-time setup for the SRE agent on Claude Managed Agents (npm run sre:setup). Creates the
// workspace environment, the runbook skill, the team memory and the agent's notebook, and the
// agent itself, then records their IDs in ops/sre-agent.lock.json. Safe to run again: it creates
// only what's missing, and publishes a new version of the skill or the agent when its files change.
import { toFile } from "@anthropic-ai/sdk";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { anthropicClient, loadConfig, loadLock, saveLock, sha256 } from "./config.js";
import { CUSTOM_TOOLS } from "./tools.js";

const client = anthropicClient();
const config = loadConfig();
const lock = loadLock();

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

// 1. The sandbox the agent works in: no internet except package registries (for npm ci).
if (!lock.environmentId) {
  const environment = await client.beta.environments.create({
    name: "sre-agent",
    config: { type: "cloud", networking: { type: "limited", allow_package_managers: true } },
  });
  lock.environmentId = environment.id;
  console.log(`Environment: ${environment.id}`);
}

// 2. The runbook, as a skill the agent loads at the start of every incident.
const runbook = readFileSync("sre/agent/runbook/SKILL.md", "utf8");
const runbookFile = () =>
  toFile(Buffer.from(runbook), "incident-runbook/SKILL.md", { type: "text/markdown" });
if (!lock.skillId) {
  const skill = await client.skills.create({
    files: [await runbookFile()],
    display_name: "Incident runbook",
  });
  lock.skillId = skill.id;
  console.log(`Runbook skill: ${skill.id}`);
} else if (lock.skillHash !== sha256(runbook)) {
  await client.skills.versions.create(lock.skillId, { files: [await runbookFile()] });
  console.log("Runbook skill: published a new version");
}
lock.skillHash = sha256(runbook);

// 3. Team memory (read-only in sessions) and the agent's own notebook (read-write).
if (!lock.teamMemoryId) {
  const store = await client.beta.memoryStores.create({
    name: "team-memory",
    description:
      "What the platform team knows: which services share what, log lines that are known noise, how post-mortems are written, and past incidents.",
  });
  lock.teamMemoryId = store.id;
  console.log(`Team memory: ${store.id}`);
}
const seedDir = "sre/agent/memory-seed";
for (const file of filesUnder(seedDir)) {
  const path = `/${relative(seedDir, file).split(sep).join("/")}`;
  const content = readFileSync(file, "utf8");
  try {
    await client.beta.memoryStores.memories.create(lock.teamMemoryId, { path, content });
    console.log(`  seeded ${path}`);
  } catch (error) {
    const conflict = (error as { error?: { error?: { conflicting_memory_id?: string } } }).error
      ?.error?.conflicting_memory_id;
    if (!conflict) throw error;
    await client.beta.memoryStores.memories.update(conflict, {
      memory_store_id: lock.teamMemoryId,
      content,
    });
  }
}
if (!lock.notebookMemoryId) {
  const store = await client.beta.memoryStores.create({
    name: "sre-notebook",
    description:
      "The SRE agent's own notes from earlier incidents: patterns it noticed, false leads, and what fixed things. Read at the start; add one or two lines at the end.",
  });
  lock.notebookMemoryId = store.id;
  console.log(`Notebook: ${store.id}`);
}

// 4. The agent. Its workspace tools run without asking because the sandbox holds no credentials
//    and can reach only package registries; everything that touches GitHub or Azure is a custom
//    tool that this repository's code runs and checks.
const system = readFileSync("sre/agent/system.md", "utf8");
const agentConfig = {
  name: "SRE agent",
  description: "Investigates alerts on platform tools and proposes fixes as draft pull requests.",
  model: config.model,
  system,
  tools: [
    {
      type: "agent_toolset_20260401" as const,
      default_config: { enabled: true, permission_policy: { type: "always_allow" as const } },
      configs: [
        { name: "web_fetch" as const, enabled: false },
        { name: "web_search" as const, enabled: false },
      ],
    },
    ...CUSTOM_TOOLS,
  ],
  skills: [{ type: "custom" as const, skill_id: lock.skillId, version: "latest" }],
};
const agentHash = sha256(JSON.stringify(agentConfig));
if (!lock.agentId) {
  const agent = await client.beta.agents.create(agentConfig);
  lock.agentId = agent.id;
  lock.agentVersion = agent.version;
  console.log(`Agent: ${agent.id} (version ${agent.version})`);
} else if (lock.agentHash !== agentHash) {
  const agent = await client.beta.agents.update(lock.agentId, {
    ...agentConfig,
    version: lock.agentVersion as number,
  });
  lock.agentVersion = agent.version;
  console.log(`Agent: published version ${agent.version}`);
}
lock.agentHash = agentHash;

saveLock(lock);
console.log("Saved the IDs to ops/sre-agent.lock.json.");
