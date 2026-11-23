// The afternoon platform report. Run by .github/workflows/daily-report.yml on weekdays at 3 pm
// Brisbane time, or by hand:
//   npm run report:sample   example data, no Azure needed, prints instead of posting
//   npm run report          the real thing (needs `az login` and ops/daily-report.json filled in)
// Flags: --sample (example data), --dry-run (don't post to Teams), --no-agent (plain report only),
//        --post (with --sample: send the example to Teams, to test the webhook).
import { appendFileSync, readFileSync } from "node:fs";
import { loadRegistry } from "../platform/model.js";
import { collect } from "./collect.js";
import type { ReportConfig } from "./model.js";
import { buildPrompt, renderPlain, stepSummary, teamsPayload } from "./render.js";
import { sampleFacts } from "./sample.js";
import { summarise } from "./summarise.js";

const flags = new Set(process.argv.slice(2));
const configPath = process.env.REPORT_CONFIG ?? "ops/daily-report.json";
const fromFile = JSON.parse(readFileSync(configPath, "utf8")) as ReportConfig;
// Every tool in the register is reported on, whether it was built new or migrated.
const registered = loadRegistry().map((t) => ({
  name: t.name,
  owner: t.owner,
  resourceGroup: t.resourceGroup,
  parameters: t.parameters,
  dailyBudget: t.dailyBudget,
  kind: t.kind,
  repo: t.repo,
  baseBranch: t.baseBranch,
}));
const config: ReportConfig = {
  ...fromFile,
  tools: [
    ...fromFile.tools.filter((t) => !registered.some((r) => r.name === t.name)),
    ...registered,
  ],
};

const facts = flags.has("--sample") ? sampleFacts(config) : await collect(config);
const plain = renderPlain(facts);

let sent = plain;
let writer = "the plain report, without the agent";
if (!flags.has("--no-agent")) {
  try {
    const written = await summarise(buildPrompt(facts), config.foundry);
    if (written) {
      sent = written;
      writer = `the agent (${config.foundry.model} on Microsoft Foundry)`;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`The agent couldn't write the report, so the plain report goes out: ${reason}`);
  }
}

console.log(sent);
console.log(`\nSent: ${writer}.`);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary(sent, plain, writer));
}

const webhook = process.env.TEAMS_WEBHOOK_URL;
if (!webhook) {
  console.log("No TEAMS_WEBHOOK_URL set, so nothing was posted.");
} else if (flags.has("--dry-run") || (flags.has("--sample") && !flags.has("--post"))) {
  console.log("Dry run: nothing was posted to Teams.");
} else {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(teamsPayload(`${facts.title} · ${facts.date}`, sent)),
  });
  if (response.ok) {
    console.log("Posted to Teams.");
  } else {
    console.error(`Teams didn't accept the report (HTTP ${response.status}).`);
    process.exitCode = 1;
  }
}
