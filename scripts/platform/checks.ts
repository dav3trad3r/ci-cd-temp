// The check every tool runs on every pull request (actions/checks). Compares each result with the
// tool's baseline, writes a summary, and tells the deploy jobs whether the tool is safe to ship.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHECK_LABELS, evaluate, hasFailed, isReady } from "./baseline.js";
import { loadManifest } from "./model.js";
import { collectResults, loadBaseline, summaryTable } from "./run-checks.js";

const dir = resolve(process.env.PLATFORM_TOOL_PATH || ".");
const manifest = loadManifest(dir);
const baseline = loadBaseline(dir);

console.log(`Checking ${manifest.name} (${manifest.kind} tool).`);
const raw = await collectResults({
  dir,
  manifest,
  onResult: (result) => {
    const evaluated = evaluate(result, baseline);
    console.log(`${CHECK_LABELS[result.name]}: ${evaluated.status} (${evaluated.detail})`);
    if (evaluated.status === "fail" && result.output) {
      console.log(result.output.trim().split("\n").slice(-40).join("\n"));
    }
  },
});

const results = raw.map((result) => evaluate(result, baseline));
const ready = isReady(results);
const failed = hasFailed(results);
const headline = failed
  ? "A check failed. Fix the code, not the check."
  : ready
    ? "Ready to deploy."
    : "This change can merge, but the tool can't deploy until the serious issues are fixed.";
const summary = `## ${manifest.name}: ${headline}\n\n${summaryTable(results)}\n`;

console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
if (failed) process.exit(1);
