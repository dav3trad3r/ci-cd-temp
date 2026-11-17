// AI evaluation regression check. Runs every known-answer case through the classifier
// and fails if accuracy drops below the baseline. Run it nightly (it can cost money once
// the classifier calls a real model) and before merging any prompt or model change.
import { appendFile, readFile } from "node:fs/promises";
import { classifyEnquiry } from "../src/lib/classify.js";

interface Case {
  input: string;
  expected: string;
}

const cases = JSON.parse(
  await readFile(new URL("./cases.json", import.meta.url), "utf8"),
) as Case[];
const { minAccuracy } = JSON.parse(
  await readFile(new URL("./baseline.json", import.meta.url), "utf8"),
) as { minAccuracy: number };

const misses: string[] = [];
for (const c of cases) {
  const got = classifyEnquiry(c.input);
  if (got !== c.expected) misses.push(`"${c.input}": expected ${c.expected}, got ${got}`);
}

const accuracy = (cases.length - misses.length) / cases.length;
const summary = [
  `AI evaluation: ${cases.length - misses.length} of ${cases.length} correct (${(accuracy * 100).toFixed(1)}%), baseline ${(minAccuracy * 100).toFixed(1)}%`,
  ...misses.map((m) => `- miss: ${m}`),
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (accuracy < minAccuracy) {
  console.error(
    "Accuracy fell below the baseline. Fix the regression or explain the drop in the pull request.",
  );
  process.exit(1);
}
